// SPDX-License-Identifier: GPL-3.0-or-later
// Dashboard: Home (overview), Import, Batches, Queue, Blocked, Settings.
import {
  h, icon, hydrateIcons, send, stateLabel, download, onStateChange, toast, confirmDialog,
  t, fmtNum, fmtAgo, fmtDuration,
} from '../lib/dom.js'
import { parseUserList, isQueued, itemKey, queueKeys, toCsv } from '../lib/user-list.js'
import { browser } from '../lib/compat.js'

const $ = (id) => document.getElementById(id)
const RENDER_LIMIT = 500
const BATCH_LIMIT = 50
const selected = new Set() // blocked account IDs picked for unblocking
const openBatches = new Set() // batches whose account list is expanded
const ACCOUNT_PAGE = 50
const accountsShown = {} // batch id -> how many accounts are listed
let data = null
// Which stored collections each section needs; only those are fetched and re-rendered.
const NEEDS = {
  home: ['batches', 'queue'],
  import: [],
  batches: ['batches'],
  queue: ['queue'],
  blocked: ['blocked', 'queue', 'batches'],
  settings: ['log'],
}
const ROUTES = Object.keys(NEEDS)
let current = 'home'
let filteredBlocked = []

const I18N = globalThis.XB_I18N

function when(at) {
  const d = new Date(at)
  const time = I18N.time(d)
  return new Date().toDateString() === d.toDateString()
    ? t('dash.today', { time })
    : t('dash.dateTime', { date: I18N.date(d), time })
}

// Accounts known only by ID link to x.com/i/user/<id>, which X redirects to
// the profile, so every row can be opened even before its @handle is known.
function profileUrl({ screenName, id }) {
  if (screenName) return `https://x.com/${encodeURIComponent(screenName)}`
  return /^\d{1,20}$/.test(String(id)) ? `https://x.com/i/user/${id}` : null
}

function accountCell(account) {
  const { screenName, name, avatar, id } = account
  const url = profileUrl(account)
  const label = screenName ? `@${screenName}` : t('dash.accountId', { id })
  return h('div', { class: 'account' },
    avatar
      ? h('img', { class: 'avatar', src: avatar, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' })
      : h('div', { class: 'avatar' }),
    h('div', { class: 'meta' },
      h('span', { class: 'name', dir: 'auto' }, name || label),
      url
        ? h('a', {
          class: 'handle', dir: 'ltr', href: url, target: '_blank', rel: 'noopener noreferrer',
          title: screenName ? t('dash.openHandle', { handle: `@${screenName}` }) : t('dash.openId', { id }),
        }, label)
        : h('span', { class: 'handle', dir: 'ltr' }, label)))
}

function emptyRow(cols, iconName, title, text) {
  return h('tr', { class: 'empty' }, h('td', { colspan: cols }, emptyState(iconName, title, text)))
}

function emptyState(iconName, title, text) {
  return h('div', { class: 'empty-state' }, icon(iconName), h('b', {}, title), h('span', {}, text))
}

async function action(fn) {
  try {
    return await fn()
  } catch (e) {
    toast(e, { error: true })
  } finally {
    await refresh()
  }
}

// How many rows each long list shows; "Show more" raises it a page at a time.
const PAGE = { batches: BATCH_LIMIT, queue: RENDER_LIMIT, blocked: RENDER_LIMIT }
const shown = { ...PAGE }

function moreFoot(el, key, total) {
  if (total <= shown[key]) return el.replaceChildren()
  const next = Math.min(PAGE[key], total - shown[key])
  el.replaceChildren(
    h('span', {}, t('dash.showing', { shown: shown[key], total })),
    h('button', {
      class: 'btn btn-sm', onclick: () => { shown[key] += PAGE[key]; renderers[key]() },
    }, t('dash.showMore', { n: next })))
}

const meter = (el, value, max) => { el.style.width = max ? `${Math.min(100, (value / max) * 100)}%` : '0' }

// ---- status (sidebar + Home) --------------------------------------------------

function renderStatus() {
  const { runner, counts, settings } = data
  const active = runner.state === 'running' || runner.state === 'cooldown'
  const processed = runner.done + (runner.unblocked ?? 0) + runner.failed + runner.skipped
  const total = processed + counts.queue
  const label = stateLabel(runner)

  for (const id of ['status', 'now-status']) {
    $(id).textContent = label
    $(id).dataset.state = runner.state
  }
  $('queue-left').textContent = counts.queue ? t('dash.mini.left', { n: counts.queue }) : ''
  meter($('mini-bar'), total - counts.queue, total)
  $('n-waiting').textContent = counts.queue ? fmtNum(counts.queue) : ''
  $('n-blocked').textContent = counts.blocked ? fmtNum(counts.blocked) : ''

  const startLabel = t(runner.state === 'paused' ? 'dash.resume' : 'dash.start')
  for (const [start, pause] of [['start', 'pause'], ['now-start', 'now-pause']]) {
    // Nothing to start when nothing waits: no dead button.
    $(start).hidden = active || counts.queue === 0
    $(pause).hidden = !active
    $(start).querySelector('span').textContent = startLabel
  }

  // Home: what is being worked on, and when it will be done.
  const head = data.queue?.[0]
  const batch = head && data.batches?.find((b) => b.id === head.batch)
  $('now-title').textContent = counts.queue ? (batch?.source ?? t('dash.now.working')) : t('dash.now.nothing')
  const parts = []
  if (counts.queue) {
    parts.push(t('dash.now.done', { done: total - counts.queue, total }))
    if (runner.state !== 'paused' && runner.state !== 'error') parts.push(t('dash.now.left', { time: fmtDuration(counts.etaMs) }))
  }
  if (runner.state === 'cooldown' || runner.state === 'error' || (runner.state === 'paused' && runner.message)) {
    parts.push(runner.message)
  }
  $('now-detail').textContent = parts.filter(Boolean).join(t('common.sep')) || t('dash.listHint')
  meter($('now-bar'), total - counts.queue, total)
  $('now-bar').parentElement.hidden = !counts.queue

  // Safety limits: why the queue may be waiting.
  const limit = (id, used, cap) => {
    $(id).textContent = cap ? t('dash.limits.value', { used, cap }) : t('dash.limits.none', { used })
    meter($(`${id}-bar`), used, cap)
    $(`${id}-bar`).parentElement.className = `meter ${cap && used >= cap ? 'meter-warn' : ''}`
  }
  limit('lim-hour', counts.lastHour, settings.hourlyCap)
  limit('lim-day', counts.last24h, settings.dailyCap)

  const legacy = counts.legacyCollected
  $('legacy').hidden = !legacy
  $('legacy-title').textContent = t('dash.legacy.title', { n: legacy })
}

// ---- Batches & queue ------------------------------------------------------------

function batchCounts(b) {
  const done = b.action === 'unblock' ? 'dash.batch.unblocked' : 'dash.batch.blocked'
  return [
    b.done ? t(done, { n: b.done }) : '',
    b.waiting ? t('dash.batch.waiting', { n: b.waiting }) : '',
    b.skipped ? t('dash.batch.skipped', { n: b.skipped }) : '',
    b.failed ? t('dash.batch.failed', { n: b.failed }) : '',
    b.cancelled ? t('dash.batch.cancelled', { n: b.cancelled }) : '',
  ].filter(Boolean).join(t('common.sep')) || t('dash.batch.nothing')
}

async function toggleBatch(id) {
  if (openBatches.has(id)) openBatches.delete(id)
  else {
    openBatches.add(id)
    accountsShown[id] = ACCOUNT_PAGE
  }
  // Opening the first one fetches the blocked accounts it lists.
  await refresh().catch(() => {})
  renderBatches()
}

// Everyone in a batch that X Blocker still knows about: waiting in the queue,
// or blocked. Skipped, failed and cancelled accounts aren't kept, nor are
// accounts that were unblocked.
function batchAccounts(b) {
  const waiting = (data.queue ?? []).filter((q) => q.batch === b.id)
  const blocked = Object.values(data.blocked ?? {}).filter((x) => x.batch === b.id).sort((x, y) => y.at - x.at)
  const all = [...waiting.map((item) => ({ account: item, waiting: true })), ...blocked.map((account) => ({ account }))]
  const limit = accountsShown[b.id] ?? ACCOUNT_PAGE
  const rows = all.slice(0, limit).map(({ account, waiting: pending }) => h('li', { class: 'batch-account' },
    accountCell(account),
    h('div', { class: 'tags' },
      pending
        ? h('span', { class: `tag ${b.action === 'unblock' ? 'tag-ok' : 'tag-warn'}` }, t(b.action === 'unblock' ? 'dash.batchAccount.unblocking' : 'dash.batchAccount.waiting'))
        : h('span', { class: 'tag tag-danger' }, t('dash.batchAccount.blocked')),
      account.tries ? h('span', { class: 'tag tag-warn' }, t('dash.queue.tries', { n: account.tries })) : null,
      !pending && account.at ? h('span', { class: 'muted small', title: I18N.dateTime(account.at) }, fmtAgo(account.at)) : null)))
  const notListed = Math.max(0, b.total - all.length)
  const foot = []
  if (all.length > limit) {
    foot.push(h('button', {
      class: 'btn btn-sm',
      onclick: () => { accountsShown[b.id] = limit + ACCOUNT_PAGE; renderBatches() },
    }, t('dash.showMore', { n: Math.min(ACCOUNT_PAGE, all.length - limit) })))
  }
  if (notListed) foot.push(h('span', { class: 'muted small' }, t(b.action === 'unblock' ? 'dash.batchAccount.notListedUnblock' : 'dash.batchAccount.notListed', { n: notListed })))
  if (blocked.length && b.action !== 'unblock') {
    foot.push(h('button', {
      class: 'btn btn-sm btn-quiet', title: t('dash.batch.viewHint'),
      onclick: () => { $('b-batch').value = b.id; go('blocked') },
    }, t('dash.batch.openBlocked')))
  }
  return h('div', { class: 'batch-detail' },
    rows.length ? h('ul', { class: 'batch-accounts' }, ...rows)
      : h('p', { class: 'muted small' }, t('dash.batchAccount.none')),
    foot.length ? h('div', { class: 'batch-detail-foot' }, ...foot) : null)
}

function renderBatches() {
  const list = data.batches ?? []
  const rows = list.slice(0, shown.batches).map((b) => {
    const undo = b.action === 'unblock'
    const finished = !b.waiting
    const tone = b.waiting ? '' : b.failed && !b.done ? 'meter-danger' : 'meter-ok'
    const actions = []
    if (b.waiting) {
      actions.push(h('button', {
        class: 'btn btn-xs', title: t('dash.batch.cancelHint'),
        onclick: () => cancelBatch(b),
      }, t(b.waiting < b.total ? 'dash.batch.cancelRest' : 'dash.batch.cancel')))
    }
    if (b.total) {
      const open = openBatches.has(b.id)
      actions.push(h('button', {
        class: 'btn btn-xs', title: t('dash.batch.accountsHint'), 'aria-expanded': String(open),
        onclick: () => toggleBatch(b.id),
      }, t('dash.batch.accounts'), icon('chevron', `i i-chev${open ? ' open' : ''}`)))
    }
    if (!undo && b.done) {
      actions.push(h('button', {
        class: 'btn btn-xs', title: t('dash.batch.undoHint'),
        onclick: () => undoBatch(b),
      }, icon('undo', 'i i-flip'), t('dash.batch.undo')))
    }
    if (finished) {
      actions.push(h('button', {
        class: 'btn btn-xs btn-quiet btn-icon', title: t('dash.batch.hideHint'),
        'aria-label': t('dash.batch.remove'), onclick: () => action(() => send('batch:forget', { id: b.id })),
      }, icon('close')))
    }
    return h('li', { class: 'batch', dataset: { state: b.waiting ? 'active' : 'done' } },
      h('div', { class: 'batch-icon', dataset: { kind: undo ? 'undo' : 'block' } }, icon(undo ? 'undo' : 'block', undo ? 'i i-flip' : 'i')),
      h('div', { class: 'batch-main' },
        h('div', { class: 'row' },
          h('b', { class: 'batch-title', title: b.source, dir: 'auto' }, b.source),
          undo ? h('span', { class: 'tag tag-ok' }, t('dash.tag.unblock')) : null),
        h('span', { class: 'muted small' }, t('dash.batch.meta', { when: when(b.createdAt), n: b.total })),
        h('div', { class: `meter ${tone}` }, h('span', {
          style: `width:${b.total ? ((b.total - b.waiting) / b.total) * 100 : 0}%`,
        })),
        h('span', { class: 'small' }, batchCounts(b))),
      h('div', { class: 'batch-actions' }, actions),
      openBatches.has(b.id) ? batchAccounts(b) : null)
  })
  if (!rows.length) {
    rows.push(h('li', { class: 'batch-empty' }, emptyState('block', t('dash.batches.empty'), t('dash.listHint'))))
  }
  $('batches').replaceChildren(...rows)
  moreFoot($('batches-more'), 'batches', list.length)
}

async function cancelBatch(b) {
  const started = b.waiting < b.total
  const unblock = b.action === 'unblock'
  if (!await confirmDialog({
    title: started ? t('dash.cancel.titleStarted', { n: b.waiting }) : t('dash.cancel.title'),
    body: started ? t(unblock ? 'dash.cancel.bodyStartedUnblock' : 'dash.cancel.bodyStartedBlock')
      : t(unblock ? 'dash.cancel.bodyUnblock' : 'dash.cancel.bodyBlock', { n: b.waiting }),
    confirmLabel: t(started ? 'dash.batch.cancelRest' : 'dash.cancel.confirm'),
    cancelLabel: t('dash.cancel.keep'),
  })) return
  action(async () => {
    const r = await send('batch:cancel', { id: b.id })
    toast(t('dash.cancel.done', { n: r.cancelled }))
  })
}

async function undoBatch(b) {
  if (!await confirmDialog({
    title: t('dash.undo.title', { name: b.source }),
    body: t(b.waiting ? 'dash.undo.bodyWaiting' : 'dash.undo.body'),
    confirmLabel: t('dash.undo.confirm'),
  })) return
  action(async () => {
    const r = await send('batch:unblock', { id: b.id })
    if (r?.error) throw new Error(r.error)
    toast(r.added ? t('dash.unblockQueued', { n: r.added }) : t('dash.undo.nothing'))
  })
}

function renderWaiting() {
  const queue = data.queue ?? []
  const names = Object.fromEntries((data.batches ?? []).map((b) => [b.id, b.source]))
  $('q-actions').hidden = !queue.length
  const rows = queue.slice(0, shown.queue).map((item, i) => h('tr', {},
    h('td', { class: 'when' }, fmtNum(i + 1)),
    h('td', {}, accountCell(item)),
    h('td', {}, h('div', { class: 'tags' },
      item.action === 'unblock' ? h('span', { class: 'tag tag-ok' }, t('dash.tag.unblock')) : null,
      h('span', { class: 'tag source', dir: 'auto', title: names[item.batch] ?? item.source ?? '' }, names[item.batch] ?? item.source ?? t('dash.queue.addedHere')))),
    h('td', {}, item.tries ? h('span', { class: 'tag tag-warn' }, t('dash.queue.tries', { n: item.tries })) : ''),
    h('td', { class: 'num' }, h('button', {
      class: 'btn btn-sm btn-quiet btn-icon', title: t('dash.queue.remove'), 'aria-label': t('dash.queue.remove'),
      onclick: () => action(() => send('queue:remove', { keys: [itemKey(item)] })),
    }, icon('close')))))
  if (!rows.length) {
    rows.push(emptyRow(5, 'queue', t('dash.now.nothing'), t('dash.queue.emptyText')))
  }
  $('q-body').replaceChildren(...rows)
  moreFoot($('q-more'), 'queue', queue.length)
}

// Home is the overview: the run card is drawn by renderStatus, and these are the
// counts that lead into Batches, Queue and Blocked.
function renderHome() {
  const batches = data.batches ?? []
  const active = batches.filter((b) => b.waiting).length
  $('s-batches').textContent = fmtNum(batches.length)
  $('s-batches-sub').textContent = active ? t('dash.stat.inProgress', { n: active })
    : t(batches.length ? 'dash.stat.allDone' : 'dash.stat.noneYet')
  const waiting = data.counts.queue
  $('s-queue').textContent = fmtNum(waiting)
  $('s-queue-sub').textContent = waiting ? t('dash.stat.atPace', { time: fmtDuration(data.counts.etaMs) }) : t('dash.now.nothing')
  $('s-blocked').textContent = fmtNum(data.counts.blocked)
}

// ---- Blocked ----------------------------------------------------------------------

function batchLabel(b) {
  return t('dash.batch.label', { name: b.source, when: when(b.createdAt) })
}

function syncBatchFilter() {
  const select = $('b-batch')
  const batches = (data.batches ?? []).filter((b) => b.action !== 'unblock' && b.done)
  const options = [
    ['', t('dash.blocked.allBatches')], ...batches.map((b) => [b.id, batchLabel(b)]),
    ['seen', t('dash.blocked.seen')], ['none', t('dash.blocked.none')],
  ]
  const sig = options.map(([v, label]) => `${v}=${label}`).join('\n')
  if (select.dataset.sig === sig) return
  const value = select.value
  select.replaceChildren(...options.map(([v, label]) => h('option', { value: v }, label)))
  select.value = options.some(([v]) => v === value) ? value : ''
  select.dataset.sig = sig
}

function blockedList() {
  const q = $('b-filter').value.trim().toLowerCase()
  const batch = $('b-batch').value
  return Object.values(data.blocked)
    .filter((b) => !batch ||
      (batch === 'seen' ? b.source === 'seen' : batch === 'none' ? !b.batch && b.source !== 'seen' : b.batch === batch))
    .filter((b) => !q || `${b.screenName ?? ''} ${b.name ?? ''} ${b.id}`.toLowerCase().includes(q))
    .sort((a, b) => b.at - a.at)
}

function renderBlocked() {
  syncBatchFilter()
  const names = Object.fromEntries((data.batches ?? []).map((b) => [b.id, b.source]))
  const queued = queueKeys(data.queue)
  filteredBlocked = blockedList()
  for (const id of selected) if (!data.blocked[id] || isQueued({ id }, queued)) selected.delete(id)
  const rows = filteredBlocked.slice(0, shown.blocked).map((b) => {
    const pending = isQueued(b, queued)
    const box = h('input', {
      type: 'checkbox', checked: selected.has(b.id), disabled: pending,
      'aria-label': t('dash.blocked.select', { name: b.screenName ? `@${b.screenName}` : b.id }),
    })
    const source = b.source === 'seen' ? t('dash.blocked.seen') : names[b.batch] ?? b.reason ?? t('dash.blocked.imported')
    const tr = h('tr', { class: selected.has(b.id) ? 'selected' : '' },
      h('td', {}, box),
      h('td', {}, accountCell(b)),
      h('td', {}, h('div', { class: 'tags' },
        pending ? h('span', { class: 'tag tag-ok' }, t('dash.blocked.unblocking')) : null,
        h('span', { class: b.source === 'seen' ? 'tag' : 'tag source', dir: 'auto', title: source }, source))),
      h('td', { class: 'when', title: I18N.dateTime(b.at) }, fmtAgo(b.at)),
      h('td', { class: 'row-act' }, pending ? null : h('button', {
        class: 'btn btn-xs', type: 'button',
        title: t('dash.blocked.unblockOneTitle', { user: accountLabel(b) }),
        'aria-label': t('dash.blocked.unblockOneTitle', { user: accountLabel(b) }),
        onclick: (e) => { e.stopPropagation(); quickUnblock(b) },
      }, t('dash.blocked.unblock'))))
    box.addEventListener('change', () => {
      box.checked ? selected.add(b.id) : selected.delete(b.id)
      tr.classList.toggle('selected', box.checked)
      updateSelection()
    })
    if (!pending) {
      tr.addEventListener('click', (e) => {
        if (e.target.closest('a, input')) return
        box.click()
      })
    }
    return tr
  })
  if (!rows.length) {
    rows.push(Object.keys(data.blocked).length
      ? emptyRow(5, 'search', t('dash.blocked.noMatches'), t('dash.blocked.tryAnother'))
      : emptyRow(5, 'block', t('dash.blocked.empty'), t('dash.blocked.emptyText')))
  }
  $('b-body').replaceChildren(...rows)
  moreFoot($('b-more'), 'blocked', filteredBlocked.length)
  updateSelection()
}

function selectable() {
  const queued = queueKeys(data.queue)
  return filteredBlocked.filter((b) => !isQueued(b, queued))
}

const accountLabel = (b) => (b.screenName ? `@${b.screenName}` : `ID ${b.id}`)

// One account, one click: queued for unblocking at the usual pace, with Undo
// while it waits. Not worth a confirmation: nothing happens until its turn.
function quickUnblock(b) {
  const item = { id: b.id, screenName: b.screenName, source: b.reason }
  const user = accountLabel(b)
  action(async () => {
    const r = await send('blocked:quickUnblock', { items: [item] })
    // Queued is what matters: when no x.com tab can run it yet, it simply waits.
    if (!r.added) {
      if (r.error) throw new Error(r.error)
      return toast(t('dash.blocked.unblockOneNothing', { user }))
    }
    toast(t('dash.blocked.unblockOneQueued', { user }), {
      action: { label: t('dash.batch.undo'), run: () => action(() => send('queue:remove', { keys: [itemKey(item)] })) },
    })
    if (r.error) toast(r.error, { error: true })
  })
}

function updateSelection() {
  const n = selected.size
  const all = selectable()
  const box = $('b-select-all')
  box.checked = n > 0 && all.every((b) => selected.has(b.id))
  box.indeterminate = n > 0 && !box.checked
  box.disabled = all.length === 0
  $('b-selected').textContent = n ? t('dash.blocked.selected', { n })
    : all.length ? t('dash.blocked.selectAllN', { n: all.length }) : t('dash.blocked.selectAll')
  $('b-unblock').disabled = n === 0
  $('b-unblock').textContent = n ? t('dash.blocked.unblockN', { n }) : t('dash.blocked.unblock')
  $('b-selection').classList.toggle('active', n > 0)
}

// ---- Settings ---------------------------------------------------------------------

let editingSettings = false

function renderSettings() {
  renderLog()
  if (editingSettings) return
  const form = $('settings')
  for (const [k, v] of Object.entries(data.settings)) {
    const el = form.elements[k]
    if (!el || el instanceof RadioNodeList) {
      if (el) el.value = v
      continue
    }
    if (el.type === 'checkbox') el.checked = v
    else if (Array.isArray(v)) el.value = v.map((s) => `@${s}`).join('\n')
    else el.value = v
  }
  // Delays are stored in milliseconds but edited in seconds.
  form.elements.delaySec.value = data.settings.delayMs / 1000
  form.elements.jitterSec.value = data.settings.jitterMs / 1000
}

function renderLog() {
  const items = [...(data.log ?? [])].reverse().map((l) => h('li', { dataset: { level: l.level } },
    h('time', { datetime: new Date(l.at).toISOString(), title: I18N.dateTime(l.at) },
      I18N.time(l.at)),
    h('span', { class: 'dot' }),
    h('span', {}, l.text)))
  if (!items.length) items.push(h('li', { class: 'log-empty muted' }, t('dash.log.empty')))
  $('l-body').replaceChildren(...items)
}

function readSettings() {
  const f = $('settings').elements
  return {
    language: f.language.value,
    blockButtons: f.blockButtons.value,
    blockAction: f.blockAction.value,
    reviewBeforeBlock: f.reviewBeforeBlock.checked,
    // Delays are edited in seconds and stored in milliseconds.
    delayMs: Math.max(2000, Math.round((Number(f.delaySec.value) || 0) * 1000)),
    jitterMs: Math.max(0, Math.round((Number(f.jitterSec.value) || 0) * 1000)),
    cooldownMin: Math.max(1, Number(f.cooldownMin.value) || 1),
    dailyCap: Math.max(0, Number(f.dailyCap.value) || 0),
    hourlyCap: Math.max(0, Number(f.hourlyCap.value) || 0),
    skipFollowing: f.skipFollowing.checked,
    skipFollowers: f.skipFollowers.checked,
    skipVerified: f.skipVerified.checked,
    whitelist: f.whitelist.value.split(/[\s,]+/).filter(Boolean),
  }
}

let saveTimer = null
function saveSettings(immediate) {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(async () => {
    try {
      await send('settings:set', { patch: readSettings() })
      toast(t('dash.settings.saved'), { timeout: 1500 })
    } catch (e) {
      toast(e, { error: true })
    }
  }, immediate ? 0 : 600)
}

$('settings').addEventListener('focusin', (e) => { if (!e.target.closest('summary, button')) editingSettings = true })
$('settings').addEventListener('focusout', () => { editingSettings = false })
$('settings').addEventListener('change', (e) => {
  saveSettings(e.target.type === 'checkbox' || e.target.type === 'radio' || e.target.name === 'language')
  if (e.target.name === 'language') applyLanguage(e.target.value)
})

// Switches the page's language in place: static text, then everything drawn by script.
let languagePref = (() => { try { return localStorage.getItem('xb-language') ?? 'auto' } catch { return 'auto' } })()
function applyLanguage(pref) {
  if (pref === languagePref) return
  languagePref = pref
  I18N.setLanguage(pref)
  I18N.localize()
  delete $('b-batch').dataset.sig
  updateImportPreview()
  go(current)
}

$('settings').addEventListener('submit', (e) => e.preventDefault())

// ---- routing & refresh ---------------------------------------------------------------

const renderers = {
  home: renderHome, import: () => {}, batches: renderBatches, queue: renderWaiting,
  blocked: renderBlocked, settings: renderSettings,
}

async function refresh(changed) {
  // Home's status card needs the batches and queue whichever section is open.
  // An open batch lists its blocked accounts too.
  const extra = current === 'batches' && openBatches.size ? ['blocked'] : []
  const needs = [...new Set([...NEEDS[current], ...extra, 'batches', 'queue'])]
  const keys = changed ? needs.filter((k) => changed.includes(k) || (k === 'batches' && changed.includes('queue'))) : needs
  const res = await send('data:get', { keys })
  data = { queue: [], blocked: {}, log: [], batches: [], ...data, ...res }
  // The language may also have been changed in the popup.
  if (data.settings?.language) applyLanguage(data.settings.language)
  renderStatus()
  if (!changed || keys.length || current === 'settings') renderers[current]()
}

function go(name) {
  current = ROUTES.includes(name) ? name : 'home'
  for (const b of document.querySelectorAll('#tabs .nav-item')) {
    if (b.dataset.tab === current) b.setAttribute('aria-current', 'page')
    else b.removeAttribute('aria-current')
  }
  // On a phone the strip scrolls sideways; keep the open section visible.
  if (matchMedia('(max-width: 760px)').matches) {
    document.querySelector(`#tabs .nav-item[data-tab="${current}"]`)?.scrollIntoView({ block: 'nearest', inline: 'center' })
  }
  for (const s of document.querySelectorAll('main .panel')) s.hidden = s.id !== `tab-${current}`
  if (data) refresh().catch((e) => toast(e, { error: true }))
  history.replaceState(null, '', `#${current}`)
  // Tab titles render as plain text: drop the bidi isolation marks around the page name.
  document.title = t('dash.title', { page: document.querySelector(`#tab-${current} h1`).textContent }).replace(/[\u2068\u2069]/g, '')
}

I18N.localize()
hydrateIcons()
for (const [code, name] of Object.entries(I18N.LANGUAGES)) {
  $('settings').elements.language.append(h('option', { value: code, lang: code }, name))
}
$('version').textContent = `v${browser.runtime.getManifest().version}`
for (const b of document.querySelectorAll('#tabs .nav-item')) b.addEventListener('click', () => go(b.dataset.tab))
for (const b of document.querySelectorAll('[data-go]')) b.addEventListener('click', () => go(b.dataset.go))
document.querySelector('.brand').addEventListener('click', (e) => { e.preventDefault(); go('home') })
$('open-import').addEventListener('click', () => go('import'))

for (const id of ['start', 'now-start']) $(id).addEventListener('click', () => action(() => send('runner:start')))
for (const id of ['pause', 'now-pause']) $(id).addEventListener('click', () => action(() => send('runner:pause')))

$('legacy-queue').addEventListener('click', () => action(async () => {
  const r = await send('legacy:queue')
  toast(t(r.skipped ? 'dash.legacy.addedSkipped' : 'dash.legacy.added', { n: r.added, skipped: r.skipped }))
}))
$('legacy-discard').addEventListener('click', async () => {
  if (await confirmDialog({
    title: t('dash.legacy.discardTitle'),
    body: t('dash.legacy.discardBody'),
    confirmLabel: t('dash.legacy.discard'),
  })) action(() => send('legacy:discard'))
})

$('q-clear').addEventListener('click', async (e) => {
  e.preventDefault()
  if (await confirmDialog({
    title: t('dash.queue.clearTitle'),
    body: t('dash.queue.clearBody', { n: data.queue.length }),
    confirmLabel: t('dash.queue.clearConfirm'),
  })) action(() => send('queue:clear'))
})
$('q-export').addEventListener('click', (e) => {
  e.preventDefault()
  download('x-blocker-queue.csv', toCsv(data.queue, ['id', 'screenName', 'source', 'action']))
})

function updateImportPreview() {
  const n = parseUserList($('i-text').value).length
  $('i-preview').textContent = n ? t('dash.import.recognised', { n }) : ''
  $('i-add').disabled = n === 0
  $('i-add').textContent = n ? t('dash.import.addN', { n }) : t('dash.import.add')
}
$('i-text').addEventListener('input', updateImportPreview)
$('i-file').addEventListener('change', async (e) => {
  const file = e.target.files?.[0]
  if (!file) return
  $('i-text').value = await file.text()
  if (!$('i-name').value) $('i-name').value = file.name.replace(/\.\w+$/, '')
  e.target.value = ''
  updateImportPreview()
})
$('i-add').addEventListener('click', () => action(async () => {
  const items = parseUserList($('i-text').value)
  if (!items.length) throw new Error(t('dash.import.noneFound'))
  const source = $('i-name').value.trim() || t('dash.import.defaultName')
  const r = await send('queue:add', { source, items: items.map((it) => ({ ...it, source })) })
  $('i-text').value = ''
  $('i-name').value = ''
  updateImportPreview()
  toast(t(r.skipped ? 'dash.import.addedSkipped' : 'dash.import.added', { n: r.added, name: source, skipped: r.skipped }))
  go('home')
}))

// A new search or batch starts again from the first page.
const refilter = () => { shown.blocked = PAGE.blocked; renderBlocked() }
$('b-filter').addEventListener('input', refilter)
$('b-batch').addEventListener('change', refilter)
$('b-select-all').addEventListener('change', (e) => {
  if (e.target.checked) for (const b of selectable()) selected.add(b.id)
  else selected.clear()
  renderBlocked()
})
$('b-unblock').addEventListener('click', async () => {
  const items = [...selected].map((id) => data.blocked[id]).filter(Boolean)
    .map((b) => ({ id: b.id, screenName: b.screenName, source: b.reason }))
  if (!items.length) return
  const n = items.length
  if (!await confirmDialog({
    title: t('dash.blocked.unblockTitle', { n }),
    body: t('dash.blocked.unblockBody'),
    confirmLabel: t('dash.blocked.unblock'),
  })) return
  action(async () => {
    const r = await send('blocked:unblock', { items, source: t('dash.blocked.unblockSource', { n }) })
    if (r?.error) throw new Error(r.error)
    selected.clear()
    toast(t(r.skipped ? 'dash.unblockQueuedSkipped' : 'dash.unblockQueued', { n: r.added, skipped: r.skipped }))
  })
})
$('b-export').addEventListener('click', () =>
  download('x-blocker-blocked.csv', toCsv(blockedList(), ['id', 'screenName', 'name', 'at', 'reason'])))
$('b-clear').addEventListener('click', async () => {
  if (await confirmDialog({
    title: t('dash.blocked.clearTitle'),
    body: t('dash.blocked.clearBody'),
    confirmLabel: t('dash.blocked.clear'),
  })) action(() => send('blocked:clear'))
})
$('l-clear').addEventListener('click', (e) => { e.preventDefault(); action(() => send('log:clear')) })
$('reset-settings').addEventListener('click', async () => {
  if (await confirmDialog({
    title: t('dash.settings.resetTitle'),
    body: t('dash.settings.resetBody'),
    confirmLabel: t('dash.settings.reset'),
  })) {
    clearTimeout(saveTimer)
    editingSettings = false
    await action(() => send('settings:reset'))
    toast(t('dash.settings.resetDone'), { timeout: 1500 })
  }
})
$('wipe').addEventListener('click', async () => {
  if (await confirmDialog({
    title: t('dash.settings.wipeTitle'),
    body: t('dash.settings.wipeBody'),
    confirmLabel: t('dash.settings.wipeConfirm'),
  })) action(() => send('data:wipe'))
})

onStateChange((changed) => refresh(changed).catch(() => {}), 400)
// Old links (#log, #collected) land on their new home.
const legacyRoutes = { log: 'settings', collected: 'home' }
const start = location.hash.slice(1)
go(legacyRoutes[start] ?? start)
refresh().catch((e) => toast(e, { error: true }))
// Opened from the x.com panel: jump to the section it asked for.
const takeRoute = () => send('dashboard:route').then((r) => r?.route && go(r.route), () => {})
takeRoute()
browser.runtime.onMessage.addListener((msg) => { if (msg?.type === 'dashboard:go') takeRoute() })
