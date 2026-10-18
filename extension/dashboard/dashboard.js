// SPDX-License-Identifier: GPL-3.0-or-later
// Dashboard: Home (overview), Import, Batches, Queue, Blocked, Settings.
import {
  h, icon, hydrateIcons, send, stateLabel, download, onStateChange, toast, confirmDialog,
  fmtNum, fmtAgo, fmtDuration,
} from '../lib/dom.js'
import { parseUserList, isQueued, itemKey, queueKeys, toCsv } from '../lib/user-list.js'
import { browser } from '../lib/compat.js'

const $ = (id) => document.getElementById(id)
const RENDER_LIMIT = 500
const BATCH_LIMIT = 50
const selected = new Set() // blocked account IDs picked for unblocking
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

const nf = new Intl.NumberFormat()
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' })
const dateFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' })

function when(t) {
  const d = new Date(t)
  const today = new Date().toDateString() === d.toDateString()
  return today ? `Today ${timeFmt.format(d)}` : `${dateFmt.format(d)} ${timeFmt.format(d)}`
}

const plural = (n, word, many = `${word}s`) => `${fmtNum(n)} ${n === 1 ? word : many}`

// Accounts known only by ID link to x.com/i/user/<id>, which X redirects to
// the profile, so every row can be opened even before its @handle is known.
function profileUrl({ screenName, id }) {
  if (screenName) return `https://x.com/${encodeURIComponent(screenName)}`
  return /^\d{1,20}$/.test(String(id)) ? `https://x.com/i/user/${id}` : null
}

function accountCell(account) {
  const { screenName, name, avatar, id } = account
  const url = profileUrl(account)
  const label = screenName ? `@${screenName}` : `ID ${id}`
  return h('div', { class: 'account' },
    avatar
      ? h('img', { class: 'avatar', src: avatar, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' })
      : h('div', { class: 'avatar' }),
    h('div', { class: 'meta' },
      h('span', { class: 'name' }, name || label),
      url
        ? h('a', {
          class: 'handle', href: url, target: '_blank', rel: 'noopener noreferrer',
          title: screenName ? `Open @${screenName} on X` : `Open account ${id} on X`,
        }, label)
        : h('span', { class: 'handle' }, label)))
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

function moreFoot(el, key, total, note = '') {
  if (total <= shown[key]) return el.replaceChildren()
  const next = Math.min(PAGE[key], total - shown[key])
  el.replaceChildren(
    h('span', {}, `Showing ${nf.format(shown[key])} of ${nf.format(total)}.${note ? ` ${note}` : ''}`),
    h('button', {
      class: 'btn btn-sm', onclick: () => { shown[key] += PAGE[key]; renderers[key]() },
    }, `Show ${nf.format(next)} more`))
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
  $('queue-left').textContent = counts.queue ? `${nf.format(counts.queue)} left` : ''
  meter($('mini-bar'), total - counts.queue, total)
  $('n-waiting').textContent = counts.queue ? nf.format(counts.queue) : ''
  $('n-blocked').textContent = counts.blocked ? nf.format(counts.blocked) : ''

  const startLabel = runner.state === 'paused' ? 'Resume' : 'Start'
  for (const [start, pause] of [['start', 'pause'], ['now-start', 'now-pause']]) {
    // Nothing to start when nothing waits: no dead button.
    $(start).hidden = active || counts.queue === 0
    $(pause).hidden = !active
    $(start).querySelector('span').textContent = startLabel
  }

  // Home: what is being worked on, and when it will be done.
  const head = data.queue?.[0]
  const batch = head && data.batches?.find((b) => b.id === head.batch)
  $('now-title').textContent = counts.queue ? (batch?.source ?? 'Working through the queue') : 'Nothing waiting'
  const parts = []
  if (counts.queue) {
    parts.push(`${nf.format(total - counts.queue)} of ${nf.format(total)} done`)
    if (runner.state !== 'paused' && runner.state !== 'error') parts.push(`${fmtDuration(counts.etaMs)} left`)
  }
  if (runner.state === 'cooldown' || runner.state === 'error' || (runner.state === 'paused' && runner.message !== 'Paused')) {
    parts.push(runner.message)
  }
  $('now-detail').textContent = parts.filter(Boolean).join(' · ') ||
    'On x.com, open a followers, likes, reposts, replies or search page and press Review in the X Blocker panel.'
  meter($('now-bar'), total - counts.queue, total)
  $('now-bar').parentElement.hidden = !counts.queue

  // Safety limits: why the queue may be waiting.
  const limit = (id, used, cap) => {
    $(id).textContent = cap ? `${nf.format(used)} / ${nf.format(cap)}` : `${nf.format(used)} · no limit`
    meter($(`${id}-bar`), used, cap)
    $(`${id}-bar`).parentElement.className = `meter ${cap && used >= cap ? 'meter-warn' : ''}`
  }
  limit('lim-hour', counts.lastHour, settings.hourlyCap)
  limit('lim-day', counts.last24h, settings.dailyCap)

  const legacy = counts.legacyCollected
  $('legacy').hidden = !legacy
  $('legacy-title').textContent = `${plural(legacy, 'account')} from your old Collected list`
}

// ---- Batches & queue ------------------------------------------------------------

function batchCounts(b) {
  const verb = b.action === 'unblock' ? 'unblocked' : 'blocked'
  return [
    b.done ? `${nf.format(b.done)} ${verb}` : '',
    b.waiting ? `${nf.format(b.waiting)} waiting` : '',
    b.skipped ? `${nf.format(b.skipped)} skipped` : '',
    b.failed ? `${nf.format(b.failed)} failed` : '',
    b.cancelled ? `${nf.format(b.cancelled)} cancelled` : '',
  ].filter(Boolean).join(' · ') || 'Nothing processed'
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
        class: 'btn btn-xs', title: 'Take the accounts that are still waiting out of the queue',
        onclick: () => cancelBatch(b),
      }, 'Cancel rest'))
    }
    if (!undo && b.done) {
      actions.push(h('button', {
        class: 'btn btn-xs', title: 'See the accounts this batch blocked',
        onclick: () => { $('b-batch').value = b.id; go('blocked') },
      }, 'View'))
      actions.push(h('button', {
        class: 'btn btn-xs', title: 'Unblock every account this batch blocked',
        onclick: () => undoBatch(b),
      }, icon('undo'), 'Undo'))
    }
    if (finished) {
      actions.push(h('button', {
        class: 'btn btn-xs btn-quiet btn-icon', title: 'Remove from this list (blocked accounts stay blocked)',
        'aria-label': 'Remove from this list', onclick: () => action(() => send('batch:forget', { id: b.id })),
      }, icon('close')))
    }
    return h('li', { class: 'batch', dataset: { state: b.waiting ? 'active' : 'done' } },
      h('div', { class: 'batch-icon', dataset: { kind: undo ? 'undo' : 'block' } }, icon(undo ? 'undo' : 'block')),
      h('div', { class: 'batch-main' },
        h('div', { class: 'row' },
          h('b', { class: 'batch-title', title: b.source }, b.source),
          undo ? h('span', { class: 'tag tag-ok' }, 'Unblock') : null),
        h('span', { class: 'muted small' }, `${when(b.createdAt)} · ${plural(b.total, 'account')}`),
        h('div', { class: `meter ${tone}` }, h('span', {
          style: `width:${b.total ? ((b.total - b.waiting) / b.total) * 100 : 0}%`,
        })),
        h('span', { class: 'small' }, batchCounts(b))),
      h('div', { class: 'batch-actions' }, actions))
  })
  if (!rows.length) {
    rows.push(h('li', { class: 'batch-empty' }, emptyState('block', 'No batches yet',
      'On x.com, open someone\'s followers, the likes or replies of a post, or a search, then press Review in the X Blocker panel at the bottom.')))
  }
  $('batches').replaceChildren(...rows)
  moreFoot($('batches-more'), 'batches', list.length)
}

async function cancelBatch(b) {
  if (!await confirmDialog({
    title: `Cancel ${plural(b.waiting, 'waiting account')}?`,
    body: `They are taken out of the queue and won't be ${b.action === 'unblock' ? 'unblocked' : 'blocked'}. What is already done stays done.`,
    confirmLabel: 'Cancel the rest',
  })) return
  action(async () => {
    const r = await send('batch:cancel', { id: b.id })
    toast(`${plural(r.cancelled, 'account')} taken out of the queue`)
  })
}

async function undoBatch(b) {
  if (!await confirmDialog({
    title: `Undo “${b.source}”?`,
    body: `Every account this batch blocked is unblocked, one by one in an x.com tab, at the same pace and limits as blocking.${b.waiting ? ' Accounts still waiting in it are not affected; use Cancel rest for those.' : ''}`,
    confirmLabel: 'Unblock them',
  })) return
  action(async () => {
    const r = await send('batch:unblock', { id: b.id })
    if (r?.error) throw new Error(r.error)
    toast(r.added ? `${plural(r.added, 'account')} queued for unblocking` : 'Nothing to unblock: they are no longer blocked')
  })
}

function renderWaiting() {
  const queue = data.queue ?? []
  const names = Object.fromEntries((data.batches ?? []).map((b) => [b.id, b.source]))
  $('q-actions').hidden = !queue.length
  const rows = queue.slice(0, shown.queue).map((item, i) => h('tr', {},
    h('td', { class: 'when' }, i + 1),
    h('td', {}, accountCell(item)),
    h('td', {}, h('div', { class: 'tags' },
      item.action === 'unblock' ? h('span', { class: 'tag tag-ok' }, 'Unblock') : null,
      h('span', { class: 'tag source', title: names[item.batch] ?? item.source ?? '' }, names[item.batch] ?? item.source ?? 'Added in the dashboard'))),
    h('td', {}, item.tries ? h('span', { class: 'tag tag-warn' }, `${item.tries} failed`) : ''),
    h('td', { class: 'num' }, h('button', {
      class: 'btn btn-sm btn-quiet btn-icon', title: 'Remove from queue', 'aria-label': 'Remove from queue',
      onclick: () => action(() => send('queue:remove', { keys: [itemKey(item)] })),
    }, icon('close')))))
  if (!rows.length) {
    rows.push(emptyRow(5, 'queue', 'Nothing waiting',
      'Queue accounts from a review on x.com, or import a list, and they show up here.'))
  }
  $('q-body').replaceChildren(...rows)
  moreFoot($('q-more'), 'queue', queue.length)
}

// Home is the overview: the run card is drawn by renderStatus, and these are the
// counts that lead into Batches, Queue and Blocked.
function renderHome() {
  const batches = data.batches ?? []
  const active = batches.filter((b) => b.waiting).length
  $('s-batches').textContent = nf.format(batches.length)
  $('s-batches-sub').textContent = active ? `${nf.format(active)} in progress`
    : batches.length ? 'All done' : 'None yet'
  const waiting = data.counts.queue
  $('s-queue').textContent = nf.format(waiting)
  $('s-queue-sub').textContent = waiting ? `${fmtDuration(data.counts.etaMs)} at this pace` : 'Nothing waiting'
  $('s-blocked').textContent = nf.format(data.counts.blocked)
}

// ---- Blocked ----------------------------------------------------------------------

function batchLabel(b) {
  return `${b.source} · ${when(b.createdAt)}`
}

function syncBatchFilter() {
  const select = $('b-batch')
  const batches = (data.batches ?? []).filter((b) => b.action !== 'unblock' && b.done)
  const options = [['', 'All batches'], ...batches.map((b) => [b.id, batchLabel(b)]), ['seen', 'Already blocked on X'], ['none', 'Not in a batch']]
  const sig = options.map(([v, t]) => `${v}=${t}`).join('\n')
  if (select.dataset.sig === sig) return
  const value = select.value
  select.replaceChildren(...options.map(([v, t]) => h('option', { value: v }, t)))
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
      'aria-label': `Select ${b.screenName ? `@${b.screenName}` : b.id}`,
    })
    const source = b.source === 'seen' ? 'Already blocked on X' : names[b.batch] ?? b.reason ?? 'Manual / import'
    const tr = h('tr', { class: selected.has(b.id) ? 'selected' : '' },
      h('td', {}, box),
      h('td', {}, accountCell(b)),
      h('td', {}, h('div', { class: 'tags' },
        pending ? h('span', { class: 'tag tag-ok' }, 'Unblocking') : null,
        h('span', { class: b.source === 'seen' ? 'tag' : 'tag source', title: source }, source))),
      h('td', { class: 'when', title: new Date(b.at).toLocaleString() }, fmtAgo(b.at)))
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
      ? emptyRow(4, 'search', 'No matches', 'Try a different search or batch.')
      : emptyRow(4, 'block', 'No blocks yet', 'Accounts you block will be listed here.'))
  }
  $('b-body').replaceChildren(...rows)
  moreFoot($('b-more'), 'blocked', filteredBlocked.length, '"Select all" includes every match.')
  updateSelection()
}

function selectable() {
  const queued = queueKeys(data.queue)
  return filteredBlocked.filter((b) => !isQueued(b, queued))
}

function updateSelection() {
  const n = selected.size
  const all = selectable()
  const box = $('b-select-all')
  box.checked = n > 0 && all.every((b) => selected.has(b.id))
  box.indeterminate = n > 0 && !box.checked
  box.disabled = all.length === 0
  $('b-selected').textContent = n ? `${nf.format(n)} selected` : `Select all ${all.length ? nf.format(all.length) : ''}`.trim()
  $('b-unblock').disabled = n === 0
  $('b-unblock').textContent = n ? `Unblock ${nf.format(n)}` : 'Unblock'
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
    h('time', { datetime: new Date(l.at).toISOString(), title: new Date(l.at).toLocaleString() },
      new Date(l.at).toLocaleTimeString()),
    h('span', { class: 'dot' }),
    h('span', {}, l.text)))
  if (!items.length) items.push(h('li', { class: 'log-empty muted' }, 'No activity yet.'))
  $('l-body').replaceChildren(...items)
}

function readSettings() {
  const f = $('settings').elements
  return {
    blockButtons: f.blockButtons.value,
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
      toast('Settings saved', { timeout: 1500 })
    } catch (e) {
      toast(e, { error: true })
    }
  }, immediate ? 0 : 600)
}

$('settings').addEventListener('focusin', (e) => { if (!e.target.closest('summary, button')) editingSettings = true })
$('settings').addEventListener('focusout', () => { editingSettings = false })
$('settings').addEventListener('change', (e) => saveSettings(e.target.type === 'checkbox' || e.target.type === 'radio'))
$('settings').addEventListener('submit', (e) => e.preventDefault())

// ---- routing & refresh ---------------------------------------------------------------

const renderers = {
  home: renderHome, import: () => {}, batches: renderBatches, queue: renderWaiting,
  blocked: renderBlocked, settings: renderSettings,
}

async function refresh(changed) {
  // Home's status card needs the batches and queue whichever section is open.
  const needs = [...new Set([...NEEDS[current], 'batches', 'queue'])]
  const keys = changed ? needs.filter((k) => changed.includes(k) || (k === 'batches' && changed.includes('queue'))) : needs
  const res = await send('data:get', { keys })
  data = { queue: [], blocked: {}, log: [], batches: [], ...data, ...res }
  renderStatus()
  if (!changed || keys.length || current === 'settings') renderers[current]()
}

function go(name) {
  current = ROUTES.includes(name) ? name : 'home'
  for (const b of document.querySelectorAll('#tabs .nav-item')) {
    if (b.dataset.tab === current) b.setAttribute('aria-current', 'page')
    else b.removeAttribute('aria-current')
  }
  for (const s of document.querySelectorAll('main .panel')) s.hidden = s.id !== `tab-${current}`
  if (data) refresh().catch((e) => toast(e, { error: true }))
  history.replaceState(null, '', `#${current}`)
  document.title = `${document.querySelector(`#tab-${current} h1`).textContent} · X Blocker`
}

hydrateIcons()
$('version').textContent = `v${browser.runtime.getManifest().version}`
for (const b of document.querySelectorAll('#tabs .nav-item')) b.addEventListener('click', () => go(b.dataset.tab))
for (const b of document.querySelectorAll('[data-go]')) b.addEventListener('click', () => go(b.dataset.go))
document.querySelector('.brand').addEventListener('click', (e) => { e.preventDefault(); go('home') })
$('open-import').addEventListener('click', () => go('import'))

for (const id of ['start', 'now-start']) $(id).addEventListener('click', () => action(() => send('runner:start')))
for (const id of ['pause', 'now-pause']) $(id).addEventListener('click', () => action(() => send('runner:pause')))

$('legacy-queue').addEventListener('click', () => action(async () => {
  const r = await send('legacy:queue')
  toast(`${plural(r.added, 'account')} added to the queue${r.skipped ? ` · ${nf.format(r.skipped)} already queued or blocked` : ''}`)
}))
$('legacy-discard').addEventListener('click', async () => {
  if (await confirmDialog({
    title: 'Discard the old Collected list?',
    body: 'These accounts are forgotten. Nobody is blocked or unblocked.',
    confirmLabel: 'Discard',
  })) action(() => send('legacy:discard'))
})

$('q-clear').addEventListener('click', async (e) => {
  e.preventDefault()
  if (await confirmDialog({
    title: 'Clear every waiting account?',
    body: `${plural(data.queue.length, 'account')} will be taken out of the queue. Nothing already done is undone.`,
    confirmLabel: 'Clear the queue',
  })) action(() => send('queue:clear'))
})
$('q-export').addEventListener('click', (e) => {
  e.preventDefault()
  download('x-blocker-queue.csv', toCsv(data.queue, ['id', 'screenName', 'source', 'action']))
})

function updateImportPreview() {
  const n = parseUserList($('i-text').value).length
  $('i-preview').textContent = n ? `${plural(n, 'account')} recognised` : ''
  $('i-add').disabled = n === 0
  $('i-add').textContent = n ? `Add ${nf.format(n)} to the queue` : 'Add to queue'
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
  if (!items.length) throw new Error('No valid @handles or IDs found.')
  const source = $('i-name').value.trim() || 'Imported list'
  const r = await send('queue:add', { source, items: items.map((it) => ({ ...it, source })) })
  $('i-text').value = ''
  $('i-name').value = ''
  updateImportPreview()
  toast(`${plural(r.added, 'account')} added as “${source}”${r.skipped ? ` · ${nf.format(r.skipped)} already queued or blocked` : ''}`)
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
    title: `Unblock ${plural(n, 'account')}?`,
    body: 'They are unblocked one by one in an x.com tab, at the same pace and limits as blocking. ' +
      'You can pause or cancel them on Home until then.',
    confirmLabel: 'Unblock',
  })) return
  action(async () => {
    const r = await send('blocked:unblock', { items, source: `Unblock ${plural(n, 'selected account')}` })
    if (r?.error) throw new Error(r.error)
    selected.clear()
    toast(`${plural(r.added, 'account')} queued for unblocking${r.skipped ? ` · ${nf.format(r.skipped)} skipped` : ''}`)
  })
})
$('b-export').addEventListener('click', () =>
  download('x-blocker-blocked.csv', toCsv(blockedList(), ['id', 'screenName', 'name', 'at', 'reason'])))
$('b-clear').addEventListener('click', async () => {
  if (await confirmDialog({
    title: 'Clear block history?',
    body: 'This only forgets the local history and finished batches. It does NOT unblock anyone on X, and batches can no longer be undone.',
    confirmLabel: 'Clear history',
  })) action(() => send('blocked:clear'))
})
$('l-clear').addEventListener('click', (e) => { e.preventDefault(); action(() => send('log:clear')) })
$('reset-settings').addEventListener('click', async () => {
  if (await confirmDialog({
    title: 'Reset all settings?',
    body: 'Every setting goes back to its default. Your never-block list, queue and history are kept.',
    confirmLabel: 'Reset settings',
  })) {
    clearTimeout(saveTimer)
    editingSettings = false
    await action(() => send('settings:reset'))
    toast('Settings reset to defaults', { timeout: 1500 })
  }
})
$('wipe').addEventListener('click', async () => {
  if (await confirmDialog({
    title: 'Delete all X Blocker data?',
    body: 'The queue, batches, block history and activity are erased from this browser. ' +
      'Settings are kept. Nobody is unblocked on X.',
    confirmLabel: 'Delete everything',
  })) action(() => send('data:wipe'))
})

onStateChange((changed) => refresh(changed).catch(() => {}), 400)
// Old links (#log, #collected) land on their new home.
const legacyRoutes = { log: 'settings', collected: 'home' }
const start = location.hash.slice(1)
go(legacyRoutes[start] ?? start)
refresh().catch((e) => toast(e, { error: true }))
