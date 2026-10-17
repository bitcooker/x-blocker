// SPDX-License-Identifier: GPL-3.0-or-later
import {
  h, icon, hydrateIcons, send, stateLabel, download, onStateChange, toast, confirmDialog,
} from '../lib/dom.js'
import { parseUserList, itemKey, toCsv } from '../lib/user-list.js'
import { browser } from '../lib/compat.js'

const $ = (id) => document.getElementById(id)
const RENDER_LIMIT = 500
const selected = new Set()
let data = null
// Which stored collections each tab needs; only those are fetched and re-rendered.
const NEEDS = {
  collected: ['collected', 'blocked'],
  queue: ['queue', 'collected'],
  import: [],
  blocked: ['blocked', 'collected'],
  log: ['log'],
  settings: [],
}
let currentTab = 'collected'
let filteredCollected = []

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

// Merges account records, ignoring empty fields, so a record stored without a
// handle never hides one known from elsewhere.
function merge(...records) {
  const out = {}
  for (const r of records) {
    for (const [k, v] of Object.entries(r ?? {})) if (v !== undefined && v !== null && v !== '') out[k] = v
  }
  return out
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

  $('s-collected').textContent = nf.format(counts.collected)
  $('s-queue').textContent = nf.format(counts.queue)
  $('s-blocked').textContent = nf.format(counts.blocked)
  $('s-24h').textContent = nf.format(counts.last24h)
  $('n-collected').textContent = counts.collected ? nf.format(counts.collected) : ''
  $('n-queue').textContent = counts.queue ? nf.format(counts.queue) : ''
  $('n-blocked').textContent = counts.blocked ? nf.format(counts.blocked) : ''
}

// ---- collected ----------------------------------------------------------------

const pressed = (id) => $(id).getAttribute('aria-pressed') === 'true'
const isBlocked = (u) => Boolean(u.blocking || data.blocked[u.id])

// Keeps the "From" filter in sync with the sources present in Collected.
function syncSourceOptions() {
  const select = $('c-source')
  const sources = [...new Set(Object.values(data.collected).flatMap((u) => u.sources ?? []))].sort()
  const current = [...select.options].slice(1).map((o) => o.value)
  if (sources.join('\n') === current.join('\n')) return
  const value = select.value
  select.replaceChildren(h('option', { value: '' }, 'All sources'), ...sources.map((src) => h('option', { value: src }, src)))
  select.value = sources.includes(value) ? value : ''
}

function renderCollected() {
  const q = $('c-filter').value.trim().toLowerCase()
  const hideBlocked = pressed('c-hide-blocked')
  const hideFriends = pressed('c-hide-following')
  const source = $('c-source').value
  syncSourceOptions()
  filteredCollected = Object.values(data.collected)
    .filter((u) => !(hideBlocked && isBlocked(u)))
    .filter((u) => !(hideFriends && (u.following || u.followedBy)))
    .filter((u) => !source || (u.sources ?? []).includes(source))
    .filter((u) => !q || `${u.name}\n${u.screenName}\n${u.description}`.toLowerCase().includes(q))
    .sort((a, b) => b.seenAt - a.seenAt)
  for (const id of selected) if (!data.collected[id]) selected.delete(id)

  const rows = filteredCollected.slice(0, RENDER_LIMIT).map((u) => {
    const blocked = isBlocked(u)
    const box = h('input', {
      type: 'checkbox', checked: selected.has(u.id), disabled: blocked, 'aria-label': `Select @${u.screenName}`,
    })
    const tr = h('tr', { class: selected.has(u.id) ? 'selected' : '' },
      h('td', {}, box),
      h('td', {}, accountCell(u)),
      h('td', { class: 'num' }, fmtNum(u.followers)),
      h('td', {}, h('div', { class: 'tags' },
        blocked ? h('span', { class: 'tag tag-danger' }, 'Blocked') : null,
        u.following ? h('span', { class: 'tag tag-ok' }, 'Following') : null,
        u.followedBy ? h('span', { class: 'tag tag-ok' }, 'Follows you') : null,
        u.verified ? h('span', { class: 'tag tag-accent' }, 'Verified') : null)),
      h('td', {}, h('div', { class: 'tags' }, (u.sources ?? []).slice(-2).map((src) => sourceTag(src)))),
      h('td', { class: 'when', title: new Date(u.collectedAt ?? u.seenAt).toLocaleString() }, fmtAgo(u.collectedAt ?? u.seenAt)))
    box.addEventListener('change', () => {
      box.checked ? selected.add(u.id) : selected.delete(u.id)
      tr.classList.toggle('selected', box.checked)
      updateSelection()
    })
    if (!blocked) {
      tr.addEventListener('click', (e) => {
        if (e.target.closest('a, input')) return
        box.click()
      })
    }
    return tr
  })
  if (!rows.length) {
    rows.push(Object.keys(data.collected).length
      ? emptyRow(6, 'search', 'No matches', 'Try a different search or turn off the filters.')
      : emptyRow(6, 'people', 'Nothing collected yet',
        'On x.com, open a followers, likes, reposts, replies or search page, open the X Blocker panel at the bottom and press Collect.'))
  }
  $('c-body').replaceChildren(...rows)
  $('c-more').textContent = filteredCollected.length > RENDER_LIMIT
    ? `Showing the latest ${RENDER_LIMIT} of ${nf.format(filteredCollected.length)}. "Select all" includes every match.`
    : ''
  updateSelection()
}

function selectable() {
  return filteredCollected.filter((u) => !isBlocked(u))
}

function updateSelection() {
  const n = selected.size
  const all = selectable()
  const box = $('c-select-all')
  box.checked = n > 0 && all.every((u) => selected.has(u.id))
  box.indeterminate = n > 0 && !box.checked
  box.disabled = all.length === 0
  $('c-selected').textContent = n ? `${nf.format(n)} selected` : `Select all ${all.length ? nf.format(all.length) : ''}`.trim()
  $('c-queue-selected').disabled = $('c-remove').disabled = n === 0
  $('c-selection').classList.toggle('active', n > 0)
}

// ---- queue --------------------------------------------------------------------

function renderQueue() {
  const rows = data.queue.slice(0, RENDER_LIMIT).map((item, i) => {
    const u = (item.id && data.collected[item.id]) || {}
    return h('tr', {},
      h('td', { class: 'when' }, i + 1),
      h('td', {}, accountCell(merge(u, item))),
      h('td', {}, sourceTag(item.source)),
      h('td', { class: 'when', title: new Date(item.addedAt).toLocaleString() }, fmtAgo(item.addedAt)),
      h('td', {}, item.tries ? h('span', { class: 'tag' }, `${item.tries} failed`) : ''),
      h('td', { class: 'num' }, h('button', {
        class: 'btn btn-sm btn-ghost', title: 'Remove from queue', 'aria-label': 'Remove from queue',
        onclick: () => action(() => send('queue:remove', { keys: [itemKey(item)] })),
      }, icon('close'))))
  })
  if (!rows.length) {
    rows.push(emptyRow(6, 'queue', 'The queue is empty',
      'Queue accounts from the Collected tab, use Import, or click "Block all" on an x.com page.'))
  }
  $('q-body').replaceChildren(...rows)
  $('q-more').textContent = data.queue.length > RENDER_LIMIT
    ? `Showing the next ${RENDER_LIMIT} of ${nf.format(data.queue.length)}` : ''
}

// ---- blocked & log ----------------------------------------------------------

function blockedList() {
  const q = $('b-filter').value.trim().toLowerCase()
  return Object.values(data.blocked)
    .filter((b) => !q || `${b.screenName ?? ''} ${b.name ?? ''} ${b.id}`.toLowerCase().includes(q))
    .sort((a, b) => b.at - a.at)
}

function renderBlocked() {
  const list = blockedList()
  const rows = list.slice(0, RENDER_LIMIT).map((b) => h('tr', {},
    h('td', {}, accountCell(merge(data.collected[b.id], b))),
    h('td', {}, b.source === 'seen' ? h('span', { class: 'tag' }, 'Already blocked on X') : sourceTag(b.reason)),
    h('td', { class: 'when', title: new Date(b.at).toLocaleString() }, fmtAgo(b.at))))
  if (!rows.length) rows.push(emptyRow(3, 'block', 'No blocks yet', 'Accounts you block will be listed here.'))
  $('b-body').replaceChildren(...rows)
  $('b-more').textContent = list.length > RENDER_LIMIT ? `Showing ${RENDER_LIMIT} of ${nf.format(list.length)}` : ''
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
}

function readSettings() {
  const f = $('settings').elements
  return {
    collectAlways: f.collectAlways.checked,
    inPageButtons: f.inPageButtons.checked,
    delayMs: Math.max(2000, Number(f.delayMs.value) || 0),
    jitterMs: Math.max(0, Number(f.jitterMs.value) || 0),
    cooldownMin: Math.max(1, Number(f.cooldownMin.value) || 1),
    dailyCap: Math.max(0, Number(f.dailyCap.value) || 0),
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
  collected: renderCollected, queue: renderQueue, import: () => {}, blocked: renderBlocked,
  log: renderLog, settings: renderSettings,
}

async function refresh(changed) {
  const needs = NEEDS[currentTab]
  const keys = changed ? needs.filter((k) => changed.includes(k)) : needs
  const res = await send('data:get', { keys })
  data = { collected: {}, queue: [], blocked: {}, log: [], ...data, ...res }
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
document.querySelector('.brand').addEventListener('click', (e) => { e.preventDefault(); switchTab('collected') })

$('start').addEventListener('click', () => action(() => send('runner:start')))
$('pause').addEventListener('click', () => action(() => send('runner:pause')))

$('c-filter').addEventListener('input', renderCollected)
$('c-source').addEventListener('change', renderCollected)
for (const id of ['c-hide-blocked', 'c-hide-following']) {
  $(id).addEventListener('click', () => {
    $(id).setAttribute('aria-pressed', String(!pressed(id)))
    renderCollected()
  })
}
$('c-select-all').addEventListener('change', (e) => {
  if (e.target.checked) for (const u of selectable()) selected.add(u.id)
  else selected.clear()
  renderCollected()
})
$('c-queue-selected').addEventListener('click', () => action(async () => {
  const r = await send('queue:addCollected', { ids: [...selected] })
  selected.clear()
  toast(`${nf.format(r.added)} added to the queue${r.skipped ? ` · ${nf.format(r.skipped)} already queued or blocked` : ''}`)
}))
$('c-remove').addEventListener('click', () => action(async () => {
  await send('collected:remove', { ids: [...selected] })
  selected.clear()
}))
$('c-export').addEventListener('click', () =>
  download('x-blocker-collected.csv', toCsv(filteredCollected,
    ['id', 'screenName', 'name', 'followers', 'verified', 'following', 'followedBy', 'description', 'sources'])))
$('c-clear').addEventListener('click', async () => {
  if (await confirmDialog({
    title: 'Clear collected accounts?',
    body: 'This only empties the list in X Blocker. Nobody is blocked or unblocked.',
    confirmLabel: 'Clear list',
  })) action(() => send('collected:clear'))
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
$('wipe').addEventListener('click', async () => {
  if (await confirmDialog({
    title: 'Delete all X Blocker data?',
    body: 'Collected accounts, the queue, block history and activity are erased from this browser. ' +
      'Settings are kept. Nobody is unblocked on X.',
    confirmLabel: 'Delete everything',
  })) action(() => send('data:wipe'))
})

onStateChange((changed) => refresh(changed).catch(() => {}), 400)
switchTab(location.hash.slice(1) in renderers ? location.hash.slice(1) : 'collected')
refresh().catch((e) => toast(e, { error: true }))
