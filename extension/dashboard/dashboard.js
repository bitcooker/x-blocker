// SPDX-License-Identifier: GPL-3.0-or-later
import {
  h, icon, hydrateIcons, send, stateLabel, download, onStateChange, toast, confirmDialog,
} from '../lib/dom.js'
import { parseUserList, isQueued, itemKey, queueKeys, toCsv } from '../lib/user-list.js'
import { browser } from '../lib/compat.js'

const $ = (id) => document.getElementById(id)
const RENDER_LIMIT = 500
const selected = new Set() // blocked account IDs picked for unblocking
let data = null
// Which stored collections each tab needs; only those are fetched and re-rendered.
const NEEDS = {
  queue: ['queue'],
  import: [],
  blocked: ['blocked', 'queue'],
  log: ['log'],
  settings: [],
}
let currentTab = 'queue'
let filteredBlocked = []

const nf = new Intl.NumberFormat()
const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
const fmtNum = (n) => (typeof n === 'number' ? nf.format(n) : '—')
function fmtAgo(t) {
  if (!t) return ''
  const s = Math.round((t - Date.now()) / 1000)
  const abs = Math.abs(s)
  if (abs < 60) return rtf.format(s, 'second')
  if (abs < 3600) return rtf.format(Math.round(s / 60), 'minute')
  if (abs < 86400) return rtf.format(Math.round(s / 3600), 'hour')
  return rtf.format(Math.round(s / 86400), 'day')
}

// Accounts known only by ID link to x.com/i/user/<id>, which X redirects to
// the profile, so every row can be opened even before its @handle is known.
function profileUrl({ screenName, id }) {
  if (screenName) return `https://x.com/${encodeURIComponent(screenName)}`
  return /^\d{1,20}$/.test(String(id)) ? `https://x.com/i/user/${id}` : null
}

function accountCell(account) {
  const { screenName, name, avatar, description, id } = account
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
        : h('span', { class: 'handle' }, label),
      description ? h('span', { class: 'bio', title: description }, description) : null))
}

// Where an account came from: the list it was loaded from, or how it was added.
function sourceTag(source) {
  return h('span', { class: source ? 'tag tag-accent source' : 'tag', title: source ?? '' }, source || 'Manual / import')
}

function emptyRow(cols, iconName, title, text) {
  return h('tr', { class: 'empty' }, h('td', { colspan: cols },
    h('div', { class: 'empty-state' }, icon(iconName), h('b', {}, title), h('span', {}, text))))
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

// ---- sidebar / overview ---------------------------------------------------------

function renderChrome() {
  const { runner, counts } = data
  $('status').textContent = stateLabel(runner)
  $('status').dataset.state = runner.state
  const total = runner.done + runner.failed + runner.skipped + counts.queue
  const active = runner.state === 'running' || runner.state === 'cooldown'
  $('message').textContent = runner.message ||
    (active || runner.state === 'paused' ? `${runner.done} blocked · ${runner.skipped} skipped · ${runner.failed} failed` : 'Ready when you are.')
  $('queue-left').textContent = counts.queue ? `${nf.format(counts.queue)} left` : ''
  $('progress-bar').style.width = total ? `${((total - counts.queue) / total) * 100}%` : '0'
  $('start').hidden = active
  $('pause').hidden = !active
  $('start').disabled = counts.queue === 0
  $('start').querySelector('span').textContent = runner.state === 'paused' ? 'Resume blocking' : 'Start blocking'
  $('start').title = counts.queue === 0 ? 'Add accounts to the queue first' : ''
  $('q-start').hidden = active
  $('q-pause').hidden = !active
  $('q-start').disabled = $('start').disabled
  $('q-start').title = $('start').title
  $('q-start').querySelector('span').textContent = $('start').querySelector('span').textContent

  $('s-queue').textContent = nf.format(counts.queue)
  $('s-blocked').textContent = nf.format(counts.blocked)
  $('s-24h').textContent = nf.format(counts.last24h)
  $('n-queue').textContent = counts.queue ? nf.format(counts.queue) : ''
  $('n-blocked').textContent = counts.blocked ? nf.format(counts.blocked) : ''
  const legacy = counts.legacyCollected
  $('legacy').hidden = !legacy
  $('legacy-title').textContent = `${nf.format(legacy)} account${legacy === 1 ? '' : 's'} from your old Collected list`
}

// ---- queue --------------------------------------------------------------------

function renderQueue() {
  const rows = data.queue.slice(0, RENDER_LIMIT).map((item, i) => {
    return h('tr', {},
      h('td', { class: 'when' }, i + 1),
      h('td', {}, accountCell(item)),
      h('td', {}, h('div', { class: 'tags' },
        item.action === 'unblock' ? h('span', { class: 'tag tag-ok' }, 'Unblock') : null,
        sourceTag(item.source))),
      h('td', { class: 'when', title: new Date(item.addedAt).toLocaleString() }, fmtAgo(item.addedAt)),
      h('td', {}, item.tries ? h('span', { class: 'tag' }, `${item.tries} failed`) : ''),
      h('td', { class: 'num' }, h('button', {
        class: 'btn btn-sm btn-quiet', title: 'Remove from queue', 'aria-label': 'Remove from queue',
        onclick: () => action(() => send('queue:remove', { keys: [itemKey(item)] })),
      }, icon('close'))))
  })
  if (!rows.length) {
    rows.push(emptyRow(6, 'queue', 'The queue is empty',
      'On an x.com list page, open the X Blocker panel and press Review, or use Import.'))
  }
  $('q-body').replaceChildren(...rows)
  $('q-more').textContent = data.queue.length > RENDER_LIMIT
    ? `Showing the next ${RENDER_LIMIT} of ${nf.format(data.queue.length)}` : ''
}

// ---- blocked & log ----------------------------------------------------------

// Where a block came from, as shown and filtered on: the list it was reviewed
// in, "Quick block", an import, or X reporting it as already blocked.
function blockSource(b) {
  if (b.source === 'seen') return 'Already blocked on X'
  return b.reason || 'Manual / import'
}

function syncBlockedSources() {
  const select = $('b-source')
  const sources = [...new Set(Object.values(data.blocked).map(blockSource))].sort()
  select.hidden = sources.length < 2
  const current = [...select.options].slice(1).map((o) => o.value)
  if (sources.join('\n') === current.join('\n')) return
  const value = select.value
  select.replaceChildren(h('option', { value: '' }, 'All sources'), ...sources.map((src) => h('option', { value: src }, src)))
  select.value = sources.includes(value) ? value : ''
}

function blockedList() {
  const q = $('b-filter').value.trim().toLowerCase()
  const source = $('b-source').value
  return Object.values(data.blocked)
    .filter((b) => !source || blockSource(b) === source)
    .filter((b) => !q || `${b.screenName ?? ''} ${b.name ?? ''} ${b.id}`.toLowerCase().includes(q))
    .sort((a, b) => b.at - a.at)
}

function renderBlocked() {
  syncBlockedSources()
  const queued = queueKeys(data.queue)
  filteredBlocked = blockedList()
  for (const id of selected) if (!data.blocked[id] || isQueued({ id }, queued)) selected.delete(id)
  const rows = filteredBlocked.slice(0, RENDER_LIMIT).map((b) => {
    const pending = isQueued(b, queued)
    const box = h('input', {
      type: 'checkbox', checked: selected.has(b.id), disabled: pending,
      'aria-label': `Select ${b.screenName ? `@${b.screenName}` : b.id}`,
    })
    const tr = h('tr', { class: selected.has(b.id) ? 'selected' : '' },
      h('td', {}, box),
      h('td', {}, accountCell(b)),
      h('td', {}, h('div', { class: 'tags' },
        pending ? h('span', { class: 'tag tag-ok' }, 'Unblocking') : null,
        b.source === 'seen' ? h('span', { class: 'tag' }, blockSource(b)) : sourceTag(b.reason))),
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
      ? emptyRow(4, 'search', 'No matches', 'Try a different search or source.')
      : emptyRow(4, 'block', 'No blocks yet', 'Accounts you block will be listed here.'))
  }
  $('b-body').replaceChildren(...rows)
  $('b-more').textContent = filteredBlocked.length > RENDER_LIMIT
    ? `Showing ${RENDER_LIMIT} of ${nf.format(filteredBlocked.length)}. "Select all" includes every match.` : ''
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

function renderLog() {
  const items = [...data.log].reverse().map((l) => h('li', { dataset: { level: l.level } },
    h('time', { datetime: new Date(l.at).toISOString(), title: new Date(l.at).toLocaleString() },
      new Date(l.at).toLocaleTimeString()),
    h('span', { class: 'dot' }),
    h('span', {}, l.text)))
  if (!items.length) {
    items.push(h('li', { class: 'empty-state', style: 'display:grid;padding:48px' },
      icon('activity'), h('b', {}, 'No activity yet'), h('span', {}, 'Blocking events will appear here.')))
  }
  $('l-body').replaceChildren(...items)
}

// ---- settings (auto-save) -------------------------------------------------------

let editingSettings = false

function renderSettings() {
  if (editingSettings) return
  const form = $('settings')
  for (const [k, v] of Object.entries(data.settings)) {
    const el = form.elements[k]
    if (!el) continue
    if (el.type === 'checkbox') el.checked = v
    else if (Array.isArray(v)) el.value = v.map((s) => `@${s}`).join('\n')
    else el.value = v
  }
  // Delays are stored in milliseconds but edited in seconds.
  form.elements.delaySec.value = data.settings.delayMs / 1000
  form.elements.jitterSec.value = data.settings.jitterMs / 1000
}

function readSettings() {
  const f = $('settings').elements
  return {
    inPageButtons: f.inPageButtons.checked,
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

$('settings').addEventListener('focusin', () => { editingSettings = true })
$('settings').addEventListener('focusout', () => { editingSettings = false })
$('settings').addEventListener('change', (e) => saveSettings(e.target.type === 'checkbox'))
$('settings').addEventListener('submit', (e) => e.preventDefault())

// ---- wiring -------------------------------------------------------------------

const renderers = {
  queue: renderQueue, import: () => {}, blocked: renderBlocked,
  log: renderLog, settings: renderSettings,
}

async function refresh(changed) {
  const needs = NEEDS[currentTab]
  const keys = changed ? needs.filter((k) => changed.includes(k)) : needs
  const res = await send('data:get', { keys })
  data = { queue: [], blocked: {}, log: [], ...data, ...res }
  renderChrome()
  // Skip re-rendering big tables when nothing they show has changed.
  if (!changed || keys.length || currentTab === 'settings') renderers[currentTab]()
}

function switchTab(name) {
  currentTab = name
  for (const b of document.querySelectorAll('#tabs .nav-item')) {
    if (b.dataset.tab === name) b.setAttribute('aria-current', 'page')
    else b.removeAttribute('aria-current')
  }
  for (const s of document.querySelectorAll('main .panel')) s.hidden = s.id !== `tab-${name}`
  if (data) refresh().catch((e) => toast(e, { error: true }))
  history.replaceState(null, '', `#${name}`)
  document.title = `${document.querySelector(`#tab-${name} h1`).textContent} · X Blocker`
}

hydrateIcons()
$('version').textContent = `v${browser.runtime.getManifest().version}`
for (const b of document.querySelectorAll('#tabs .nav-item')) b.addEventListener('click', () => switchTab(b.dataset.tab))
document.querySelector('.brand').addEventListener('click', (e) => { e.preventDefault(); switchTab('queue') })

$('start').addEventListener('click', () => action(() => send('runner:start')))
$('pause').addEventListener('click', () => action(() => send('runner:pause')))
$('q-start').addEventListener('click', () => $('start').click())
$('q-pause').addEventListener('click', () => $('pause').click())

$('legacy-queue').addEventListener('click', () => action(async () => {
  const r = await send('legacy:queue')
  toast(`${nf.format(r.added)} added to the queue${r.skipped ? ` · ${nf.format(r.skipped)} already queued or blocked` : ''}`)
}))
$('legacy-discard').addEventListener('click', async () => {
  if (await confirmDialog({
    title: 'Discard the old Collected list?',
    body: 'These accounts are forgotten. Nobody is blocked or unblocked.',
    confirmLabel: 'Discard',
  })) action(() => send('legacy:discard'))
})

$('q-clear').addEventListener('click', async () => {
  if (await confirmDialog({
    title: 'Clear the queue?',
    body: `${nf.format(data.queue.length)} accounts will be removed from the queue and won't be blocked.`,
    confirmLabel: 'Clear queue',
  })) action(() => send('queue:clear'))
})
$('q-export').addEventListener('click', () =>
  download('x-blocker-queue.csv', toCsv(data.queue, ['id', 'screenName', 'source'])))

function updateImportPreview() {
  const n = parseUserList($('i-text').value).length
  $('i-preview').textContent = n ? `${nf.format(n)} account${n === 1 ? '' : 's'} recognised` : ''
  $('i-add').disabled = n === 0
}
$('i-text').addEventListener('input', updateImportPreview)
$('i-file').addEventListener('change', async (e) => {
  const file = e.target.files?.[0]
  if (!file) return
  $('i-text').value = await file.text()
  e.target.value = ''
  updateImportPreview()
})
$('i-add').addEventListener('click', () => action(async () => {
  const items = parseUserList($('i-text').value)
  if (!items.length) throw new Error('No valid @handles or IDs found.')
  const r = await send('queue:add', { items: items.map((it) => ({ ...it, source: 'Imported list' })) })
  $('i-text').value = ''
  updateImportPreview()
  toast(`${nf.format(r.added)} added to the queue${r.skipped ? ` · ${nf.format(r.skipped)} already queued or blocked` : ''}`)
}))

$('b-filter').addEventListener('input', renderBlocked)
$('b-source').addEventListener('change', renderBlocked)
$('b-select-all').addEventListener('change', (e) => {
  if (e.target.checked) for (const b of selectable()) selected.add(b.id)
  else selected.clear()
  renderBlocked()
})
$('b-unblock').addEventListener('click', async () => {
  const items = [...selected].map((id) => data.blocked[id]).filter(Boolean)
    .map((b) => ({ id: b.id, screenName: b.screenName, source: blockSource(b) }))
  if (!items.length) return
  const n = items.length
  if (!await confirmDialog({
    title: `Unblock ${nf.format(n)} account${n === 1 ? '' : 's'}?`,
    body: 'They are unblocked one by one in an x.com tab, at the same pace and limits as blocking. ' +
      'You can pause or remove them from the queue until then.',
    confirmLabel: 'Unblock',
  })) return
  action(async () => {
    const r = await send('blocked:unblock', { items })
    if (r?.error) throw new Error(r.error)
    selected.clear()
    toast(`${nf.format(r.added)} queued for unblocking${r.skipped ? ` · ${nf.format(r.skipped)} skipped` : ''}`)
  })
})
$('b-export').addEventListener('click', () =>
  download('x-blocker-blocked.csv', toCsv(blockedList(), ['id', 'screenName', 'name', 'at', 'reason'])))
$('b-clear').addEventListener('click', async () => {
  if (await confirmDialog({
    title: 'Clear block history?',
    body: 'This only forgets the local history. It does NOT unblock anyone on X.',
    confirmLabel: 'Clear history',
  })) action(() => send('blocked:clear'))
})
$('l-clear').addEventListener('click', () => action(() => send('log:clear')))
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
    body: 'The queue, block history and activity are erased from this browser. ' +
      'Settings are kept. Nobody is unblocked on X.',
    confirmLabel: 'Delete everything',
  })) action(() => send('data:wipe'))
})

onStateChange((changed) => refresh(changed).catch(() => {}), 400)
switchTab(location.hash.slice(1) in renderers ? location.hash.slice(1) : 'queue')
refresh().catch((e) => toast(e, { error: true }))
