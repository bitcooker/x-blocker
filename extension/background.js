// SPDX-License-Identifier: GPL-3.0-or-later
// Background (Firefox event page / Chrome service worker): single source of
// truth for extension state.
// - Accounts seen in X's responses go into a session-only "seen" cache used for
//   safety checks and lookups. Nothing is saved until the user queues accounts.
// - Captures users from X GraphQL responses: on Firefox passively via
//   webRequest.filterResponseData; on Chrome, which has no response-body API,
//   from bodies forwarded by content/capture-hook.js.
// - Owns the queue of blocks and unblocks; an x.com tab (content/bridge.js)
//   executes it and asks for one item at a time, so progress survives reloads
//   and restarts.
import { browser, onMessage } from './lib/compat.js'
import { extractUsers } from './lib/extract-users.js'
import { dedupeItems, isQueued, itemKey, queueKeys } from './lib/user-list.js'

// Rate limits: X publishes no limit for blocking. Heavy blockers report being
// logged out after several hundred blocks in a burst, so the defaults spread
// blocks out (avg ~6 s, at most 150 an hour) rather than only capping the day.
const DEFAULT_SETTINGS = {
  blockButtons: 'everywhere', // per-account Block buttons: everywhere | lists | off
  delayMs: 4000,
  jitterMs: 4000,
  cooldownMin: 15,
  hourlyCap: 150,
  dailyCap: 1000,
  skipFollowing: true,
  skipFollowers: true,
  skipVerified: false,
  whitelist: [],
}
const DEFAULT_RUNNER = {
  state: 'idle', // idle | running | paused | cooldown | error
  tabId: null,
  token: null,
  lastBeat: 0,
  cooldownUntil: 0,
  message: '',
  limit: '', // what the cooldown waits for: block | lookup | daily
  done: 0,
  unblocked: 0,
  failed: 0,
  skipped: 0,
  strikes: 0, // consecutive rate limits, for exponential cooldown
}
const DEFAULTS = {
  settings: DEFAULT_SETTINGS,
  // Legacy: the old Collected list. No longer filled; the dashboard offers to
  // queue or discard what is left, once.
  collected: {},
  queue: [],
  // One batch per Review → Block (or import, undo, quick-block day): what the
  // dashboard lists, and what can be cancelled or undone as a whole.
  batches: {},
  blocked: {},
  blockTimes: [],
  log: [],
  runner: DEFAULT_RUNNER,
}
const COLLECTED_TTL = 30 * 24 * 60 * 60 * 1000 // data minimisation: forget profiles after 30 days
const MAX_COOLDOWN_MIN = 240
// Consecutive 429s for which X's own reset time is trusted before backing off.
const TRUST_RESET_STRIKES = 2
const RESET_SLACK_MS = 5_000
const MAX_LOG = 300
const MAX_TRIES = 3
const DAY = 24 * 60 * 60 * 1000
const HOUR = 60 * 60 * 1000
const STALE_MS = 60_000
const API_URLS = [
  'https://api.x.com/graphql/*',
  'https://x.com/i/api/graphql/*',
]
// Never read private traffic (DMs, chat, notifications, account/settings data).
const PRIVATE_OPS = /dm|chat|inbox|message|conversationlist|notification|bookmark|account|setting|grok|money|payment|password|email|phone|session|passkey|login|verification|delegate/i
const SAVE_DEBOUNCE_MS = 2000
const MAX_BODY = 20 * 1024 * 1024
const API_URL_RE = /^https:\/\/(?:api\.x\.com\/graphql\/|x\.com\/i\/api\/graphql\/)/

function isCapturable(url) {
  try {
    const u = new URL(url)
    return API_URL_RE.test(u.href) && !PRIVATE_OPS.test(u.pathname.split('/').pop() ?? '')
  } catch {
    return false
  }
}

function collectFromText(text) {
  try {
    const users = extractUsers(JSON.parse(text))
    if (users.length) bufferUsers(users)
  } catch {
    // Not JSON or unexpected shape; nothing to collect.
  }
}
const BIG_KEYS = new Set(['collected', 'blocked', 'log', 'blockTimes'])

// ---- state ------------------------------------------------------------------

let cache = null
let lock = Promise.resolve()

const SETTINGS_VERSION = 6
// Settings with a fixed set of values; the first is the default.
const CHOICES = { blockButtons: ['everywhere', 'lists', 'off'] }
const MIN = { delayMs: 2000, jitterMs: 0, cooldownMin: 1, hourlyCap: 0, dailyCap: 0 }

// v1 shipped with 3 s delay and no daily limit, which can get accounts
// force-logged-out. Move untouched old defaults to the safer ones.
function migrateSettings(st) {
  if ((st.version ?? 1) < 2) {
    if (st.delayMs === 3000) st.delayMs = DEFAULT_SETTINGS.delayMs
    if (st.jitterMs === 2000) st.jitterMs = DEFAULT_SETTINGS.jitterMs
    if (st.dailyCap === 0) st.dailyCap = DEFAULT_SETTINGS.dailyCap
  }
  // v3: collecting became opt-in; the old always-on switch is replaced.
  delete st.collect
  // v4: an hourly limit spreads blocks out, so the daily one can be looser.
  // Only an untouched old default moves; a value the user chose is kept.
  if ((st.version ?? 1) < 4 && st.dailyCap === 450) st.dailyCap = DEFAULT_SETTINGS.dailyCap
  // v5: accounts are reviewed and queued straight from the page; no collecting.
  // Loading a whole list is a panel action now, not an opt-in button.
  delete st.collectAlways
  delete st.autoScroll
  // v6: the panel can't be switched off any more (it is how lists are reviewed,
  // and minimizing keeps it out of the way); "off" now only hides Block buttons.
  delete st.panelMode
  if ('inPageButtons' in st || 'buttonsEverywhere' in st) {
    if (st.inPageButtons === false) st.blockButtons = 'off'
    else if (st.buttonsEverywhere === false) st.blockButtons = 'lists'
    delete st.inPageButtons
    delete st.buttonsEverywhere
  }
  for (const [k, values] of Object.entries(CHOICES)) if (!values.includes(st[k])) st[k] = values[0]
  st.version = SETTINGS_VERSION
  return st
}

let loading = null
function load() {
  loading ??= (async () => {
    const stored = await browser.storage.local.get(Object.keys(DEFAULTS))
    const c = {}
    for (const [k, v] of Object.entries(DEFAULTS)) c[k] = stored[k] ?? structuredClone(v)
    c.settings = migrateSettings({ ...DEFAULT_SETTINGS, ...c.settings })
    c.runner = { ...DEFAULT_RUNNER, ...c.runner }
    if ((stored.settings?.version ?? 1) < 3) {
      // Before v3 every account X showed was collected automatically (friends
      // included). Collecting is now opt-in, so that list starts empty.
      c.collected = {}
      await browser.storage.local.set({ collected: {} })
    }
    if (!stored.batches) {
      migrateBatches(c)
      await browser.storage.local.set({ batches: c.batches, blocked: c.blocked, queue: c.queue })
    }
    if (stored.settings?.version !== SETTINGS_VERSION) await browser.storage.local.set({ settings: c.settings })
    await loadSeen()
    cache = c
    return c
  })()
  return loading
}

// Queue and runner are written immediately (crash safety); large maps are
// coalesced so a 50k-profile object isn't rewritten on every single block.
const dirty = new Set()
let saveTimer = null

function save(...keys) {
  const now = {}
  for (const k of keys) {
    if (BIG_KEYS.has(k)) dirty.add(k)
    else now[k] = cache[k]
  }
  if (dirty.size) saveTimer ??= setTimeout(flushDirty, SAVE_DEBOUNCE_MS)
  notify(keys)
  return Object.keys(now).length ? browser.storage.local.set(now) : Promise.resolve()
}

function flushDirty() {
  saveTimer = null
  const patch = {}
  for (const k of dirty) patch[k] = cache[k]
  dirty.clear()
  return browser.storage.local.set(patch)
}

// Lightweight change notifications instead of storage.onChanged, which would
// clone the full (huge) old+new values into every listening page and tab.
let notifyKeys = new Set()
let notifyTimer = null
function notify(keys) {
  for (const k of keys) notifyKeys.add(k)
  notifyTimer ??= setTimeout(() => {
    notifyTimer = null
    const keys = [...notifyKeys]
    notifyKeys = new Set()
    browser.runtime.sendMessage({ type: 'state:changed', keys }).catch(() => {})
    if (cache && ['runner', 'queue', 'collected', 'blocked'].some((k) => keys.includes(k))) broadcastProgress()
  }, 250)
}

// Accounts left in the legacy Collected list that are still blockable.
function pendingCollected(s) {
  const queued = queueKeys(s.queue)
  return Object.values(s.collected)
    .filter((u) => !u.blocking && !s.blocked[u.id] && !isQueued(u, queued))
}

function progressPayload() {
  const { token, ...runner } = cache.runner
  const head = cache.queue[0]?.batch && cache.batches[cache.queue[0].batch]
  return {
    type: 'page:progress', runner, queueLen: cache.queue.length, last24h: last24h(cache), etaMs: estimateMs(cache),
    current: head ? { source: head.source, action: head.action } : null,
  }
}

async function broadcastProgress() {
  const tabs = await browser.tabs.query({ url: 'https://x.com/*' }).catch(() => [])
  const msg = progressPayload()
  for (const t of tabs) browser.tabs.sendMessage(t.id, msg).catch(() => {})
}

function last24h(s) {
  const now = Date.now()
  return s.blockTimes.filter((t) => now - t < DAY).length
}

// ---- seen cache (session only) ---------------------------------------------
// Every account in X's responses, kept in memory and storage.session (never on
// disk, cleared when the browser closes). Powers skip rules, the Review
// dialog, blocked-state detection and handle → ID lookups.
const MAX_SEEN = 10_000
const seen = new Map() // id -> user, oldest first
let seenLoading = null
let seenSaveTimer = null

function loadSeen() {
  seenLoading ??= (browser.storage.session?.get('seen') ?? Promise.resolve({}))
    .then((v) => { for (const u of v?.seen ?? []) if (!seen.has(u.id)) seen.set(u.id, u) })
    .catch(() => {})
  return seenLoading
}

function saveSeen() {
  seenSaveTimer ??= setTimeout(() => {
    seenSaveTimer = null
    browser.storage.session?.set({ seen: [...seen.values()] }).catch(() => {})
  }, SAVE_DEBOUNCE_MS)
}

function rememberSeen(u, now) {
  const merged = { ...seen.get(u.id) }
  for (const [k, v] of Object.entries(u)) if (v !== undefined && v !== '') merged[k] = v
  if (merged.description?.length > 200) merged.description = merged.description.slice(0, 200) + '…'
  merged.seenAt = now
  seen.delete(u.id) // re-insert to keep most recently seen last
  seen.set(u.id, merged)
  while (seen.size > MAX_SEEN) seen.delete(seen.keys().next().value)
}

// Best-known record for an account: collected first, then the seen cache.
function knownUser(s, id) {
  return s.collected[id] ?? seen.get(id)
}

// screenName (lowercase) -> id over seen + collected, rebuilt lazily.
let snIndex = null
function bySn(s, sn) {
  if (!snIndex) {
    snIndex = new Map()
    for (const u of seen.values()) snIndex.set(u.screenName.toLowerCase(), u.id)
    for (const u of Object.values(s.collected)) snIndex.set(u.screenName.toLowerCase(), u.id)
  }
  const id = snIndex.get(String(sn).toLowerCase())
  return id ? knownUser(s, id) : undefined
}

// Serialises every read-modify-write so concurrent messages cannot race.
function exclusive(fn) {
  const run = lock.then(async () => fn(await load()))
  lock = run.catch(() => {})
  return run
}

function log(s, level, text) {
  s.log.push({ at: Date.now(), level, text })
  if (s.log.length > MAX_LOG) s.log.splice(0, s.log.length - MAX_LOG)
}

function updateBadge(s) {
  const active = s.runner.state === 'running' || s.runner.state === 'cooldown'
  browser.action.setBadgeText({ text: active && s.queue.length ? String(s.queue.length) : '' })
  browser.action.setBadgeBackgroundColor({ color: s.runner.state === 'cooldown' ? '#b26b00' : '#f4212e' })
}

// ---- collecting ---------------------------------------------------------------

let collectFlush = null
const collectBuffer = new Map()

function bufferUsers(users) {
  for (const u of users) collectBuffer.set(u.id, { ...collectBuffer.get(u.id), ...u })
  collectFlush ??= setTimeout(flushCollected, 1000)
}

function flushCollected() {
  collectFlush = null
  const users = [...collectBuffer.values()]
  collectBuffer.clear()
  return exclusive(async (s) => {
    const now = Date.now()
    for (const u of users) {
      rememberSeen(u, now)
      const record = s.blocked[u.id]
      if (u.blocking && !record) {
        s.blocked[u.id] = { id: u.id, screenName: u.screenName, name: u.name, at: now, source: 'seen' }
      } else if (u.blocking === false && record) {
        // X says this account is no longer blocked (unblocked elsewhere).
        delete s.blocked[u.id]
      } else if (record) {
        // Accounts blocked by ID get their handle and name once they are seen.
        if (u.screenName) record.screenName = u.screenName
        if (u.name) record.name = u.name
      }
    }
    for (const [id, u] of Object.entries(s.collected)) {
      if (now - (u.seenAt ?? 0) > COLLECTED_TTL) delete s.collected[id]
    }
    snIndex = null
    saveSeen()
    await save('collected', 'blocked')
  })
}

function captureResponse(details) {
  if (details.tabId < 0 || !isCapturable(details.url)) return
  let filter
  try {
    filter = browser.webRequest.filterResponseData(details.requestId)
  } catch {
    return
  }
  const chunks = []
  let size = 0
  filter.ondata = (e) => {
    filter.write(e.data)
    size += e.data.byteLength
    if (size <= MAX_BODY) chunks.push(e.data)
  }
  filter.onstop = () => {
    filter.close()
    if (size > MAX_BODY) return
    const bytes = new Uint8Array(size)
    let off = 0
    for (const c of chunks) { bytes.set(new Uint8Array(c), off); off += c.byteLength }
    collectFromText(new TextDecoder().decode(bytes))
  }
  filter.onerror = () => {}
}

// Firefox only; Chrome MV3 has neither blocking webRequest nor filterResponseData.
if (browser.webRequest?.filterResponseData) {
  browser.webRequest.onBeforeRequest.addListener(
    captureResponse,
    { urls: API_URLS, types: ['xmlhttprequest'] },
    ['blocking'],
  )
}

// ---- queue --------------------------------------------------------------------

function findCollected(s, item) {
  if (item.id) return knownUser(s, item.id)
  return item.screenName ? bySn(s, item.screenName) : undefined
}

function skipReason(s, item) {
  const u = findCollected(s, item)
  const id = item.id ?? u?.id
  if (item.action === 'unblock') {
    // Only undo what is (still) recorded as blocked.
    return id && s.blocked[id] ? null : 'not blocked'
  }
  const sn = (item.screenName ?? u?.screenName ?? '').toLowerCase()
  if (id && s.blocked[id]) return 'already blocked'
  if (u?.blocking) return 'already blocked'
  if (sn && s.settings.whitelist.includes(sn)) return 'whitelisted'
  if (s.settings.skipFollowing && u?.following) return 'you follow them'
  if (s.settings.skipFollowers && u?.followedBy) return 'they follow you'
  if (s.settings.skipVerified && u?.verified) return 'verified account'
  return null
}

// ---- batches ------------------------------------------------------------------

const MAX_BATCHES = 500

function newBatch(s, source, action, id) {
  id ??= `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  s.batches[id] ??= { id, source: String(source || 'Added in the dashboard').slice(0, 120), action, createdAt: Date.now(),
    total: 0, done: 0, skipped: 0, failed: 0, cancelled: 0 }
  // Keep the newest; old finished batches are history only.
  const ids = Object.keys(s.batches)
  if (ids.length > MAX_BATCHES) {
    const waiting = new Set(s.queue.map((q) => q.batch))
    ids.filter((b) => !waiting.has(b)).sort((a, b) => s.batches[a].createdAt - s.batches[b].createdAt)
      .slice(0, ids.length - MAX_BATCHES).forEach((b) => delete s.batches[b])
  }
  return s.batches[id]
}

// Counts an outcome for the batch an item belongs to.
function countBatch(s, item, field, n = 1) {
  const b = item?.batch && s.batches[item.batch]
  if (b) b[field] = (b[field] ?? 0) + n
}

// Quick blocks from the page: one batch per day, so a day's clicks can be undone together.
const quickBatchId = () => `quick-${new Date().toISOString().slice(0, 10)}`
function quickBatch(s) {
  return newBatch(s, 'Quick blocks', 'block', quickBatchId())
}

// Batches for the dashboard, newest first, with how many accounts still wait.
function batchList(s) {
  const waiting = {}
  for (const q of s.queue) if (q.batch) waiting[q.batch] = (waiting[q.batch] ?? 0) + 1
  return Object.values(s.batches)
    .map((b) => ({ ...b, waiting: waiting[b.id] ?? 0 }))
    .sort((a, b) => b.createdAt - a.createdAt)
}

// Before batches existed: group past blocks by source and day, and waiting
// accounts by source, so they can be undone and cancelled the same way.
function migrateBatches(c) {
  c.batches = {}
  const day = (t) => new Date(t || 0).toISOString().slice(0, 10)
  for (const b of Object.values(c.blocked)) {
    if (b.source === 'seen' || b.batch) continue
    const source = b.reason || 'Quick blocks'
    const id = `m-${day(b.at)}-${source}`.replace(/[^\w-]+/g, '_').slice(0, 80)
    const batch = c.batches[id] ??= { id, source, action: 'block', createdAt: b.at, total: 0, done: 0, skipped: 0, failed: 0, cancelled: 0 }
    batch.createdAt = Math.min(batch.createdAt, b.at || batch.createdAt)
    batch.total++
    batch.done++
    b.batch = id
  }
  for (const q of c.queue) {
    if (q.batch) continue
    const source = q.source || 'Added in the dashboard'
    const id = `m-queue-${q.action ?? 'block'}-${source}`.replace(/[^\w-]+/g, '_').slice(0, 80)
    const batch = c.batches[id] ??= { id, source, action: q.action ?? 'block', createdAt: q.addedAt || Date.now(), total: 0, done: 0, skipped: 0, failed: 0, cancelled: 0 }
    batch.total++
    q.batch = id
  }
}

// Adds blocks (default) or unblocks to the queue. An account is in the queue
// at most once; unblocks need a known ID and an account recorded as blocked.
// Callers that want a shared batch (e.g. a day's quick blocks) pass its id.
function addToQueue(s, items, action = 'block', batchSource, batchId) {
  let batch = null
  const existing = new Set(s.queue.map(itemKey))
  for (const q of s.queue) if (q.id && q.screenName) existing.add(itemKey({ screenName: q.screenName }))
  let added = 0
  let skipped = 0
  const valid = (Array.isArray(items) ? items : []).filter((it) => it && typeof it === 'object' && (it.id || it.screenName))
  for (const raw of dedupeItems(valid)) {
    const item = {}
    if (raw.id && /^\d{1,20}$/.test(String(raw.id))) item.id = String(raw.id)
    if (raw.screenName && /^[A-Za-z0-9_]{1,15}$/.test(String(raw.screenName))) item.screenName = String(raw.screenName)
    if (raw.source) item.source = String(raw.source).slice(0, 120)
    if (!item.id && !item.screenName) continue
    const known = findCollected(s, item)
    if (known) Object.assign(item, { id: known.id, screenName: known.screenName })
    if (action === 'unblock') {
      if (!item.id || !s.blocked[item.id] || existing.has(itemKey(item))) { skipped++; continue }
      item.action = 'unblock'
    } else if (existing.has(itemKey(item)) || (item.id && s.blocked[item.id])) { skipped++; continue }
    existing.add(itemKey(item))
    if (item.screenName) existing.add(itemKey({ screenName: item.screenName }))
    batch ??= newBatch(s, batchSource ?? item.source, action, batchId)
    batch.total++
    s.queue.push({ ...item, batch: batch.id, addedAt: Date.now(), tries: 0 })
    added++
  }
  return { added, skipped, batch: batch?.id }
}

function removeFromQueue(s, item) {
  const keys = new Set([itemKey(item)])
  if (item.id && item.screenName) keys.add(itemKey({ screenName: item.screenName }))
  s.queue = s.queue.filter((q) => {
    if (keys.has(itemKey(q))) return false
    return !(q.id && q.screenName && keys.has(itemKey({ screenName: q.screenName })))
  })
}

// Takes waiting accounts out of the queue, counting them as cancelled in their batch.
function cancelWhere(s, pred) {
  let n = 0
  s.queue = s.queue.filter((q) => {
    if (!pred(q)) return true
    countBatch(s, q, 'cancelled')
    n++
    return false
  })
  return n
}

function markBlocking(s, id, value = true) {
  if (s.collected[id]) s.collected[id].blocking = value
  if (seen.has(id)) seen.get(id).blocking = value
}

// Drops empty fields so stored records never carry `screenName: undefined`.
function compact(record) {
  return Object.fromEntries(Object.entries(record).filter(([, v]) => v !== undefined && v !== null && v !== ''))
}

function label(item) {
  return item.screenName ? `@${item.screenName}` : `id ${item.id}`
}

function runnerAlive(r) {
  return Date.now() - r.lastBeat < STALE_MS
}

async function findXTab(preferredId) {
  if (preferredId != null) {
    const tab = await browser.tabs.get(preferredId).catch(() => null)
    if (tab?.url?.startsWith('https://x.com/')) return tab
  }
  const tabs = await browser.tabs.query({ url: 'https://x.com/*' })
  return tabs.find((t) => t.active) ?? tabs[0] ?? null
}

async function pingTab(tabId, attempts = 1) {
  for (let i = 0; i < attempts; i++) {
    const res = await browser.tabs.sendMessage(tabId, { type: 'tab:ping' }).catch(() => null)
    if (res) return res
    await new Promise((r) => setTimeout(r, 1000))
  }
  return null
}

async function startRunner(preferredTabId) {
  let tab = await findXTab(preferredTabId)
  if (!tab) tab = await browser.tabs.create({ url: 'https://x.com/home', active: false })
  const ping = await pingTab(tab.id, 20)
  if (!ping) throw new Error('Could not reach the x.com tab. Reload it and try again.')
  if (!ping.ok || !ping.loggedIn) throw new Error(ping.error?.message ?? 'You are not logged in to x.com.')
  const token = crypto.randomUUID()
  await exclusive(async (s) => {
    // Resuming a paused run keeps its counters so "n of m" continues.
    const resume = s.runner.state === 'paused'
    Object.assign(s.runner, {
      state: 'running', tabId: tab.id, token, lastBeat: Date.now(), cooldownUntil: 0, message: '', limit: '',
      ...(resume ? {} : { done: 0, unblocked: 0, failed: 0, skipped: 0, strikes: 0 }),
    })
    log(s, 'info', `Started on tab ${tab.id} with ${s.queue.length} in the queue`)
    updateBadge(s)
    await save('runner', 'log')
  })
  await browser.tabs.sendMessage(tab.id, { type: 'tab:run', token })
}

function nextItem(s, token) {
  const r = s.runner
  if (r.token !== token || (r.state !== 'running' && r.state !== 'cooldown')) return { stop: true }
  const now = Date.now()
  r.lastBeat = now
  if (r.state === 'cooldown') {
    if (now < r.cooldownUntil) return { waitMs: r.cooldownUntil - now }
    r.state = 'running'
    r.message = ''
    r.limit = ''
    log(s, 'info', 'Pause over, resuming')
  }
  s.blockTimes = s.blockTimes.filter((t) => now - t < DAY)
  if (s.settings.dailyCap > 0 && s.blockTimes.length >= s.settings.dailyCap) {
    r.state = 'cooldown'
    r.limit = 'daily'
    r.cooldownUntil = s.blockTimes[0] + DAY
    r.message = `Daily limit of ${s.settings.dailyCap} blocks reached`
    log(s, 'warn', r.message)
    return { waitMs: r.cooldownUntil - now }
  }
  const lastHour = s.blockTimes.filter((t) => now - t < HOUR)
  if (s.settings.hourlyCap > 0 && lastHour.length >= s.settings.hourlyCap) {
    r.state = 'cooldown'
    r.limit = 'hourly'
    r.cooldownUntil = lastHour[0] + HOUR
    r.message = `Hourly limit of ${s.settings.hourlyCap} blocks reached`
    log(s, 'info', r.message)
    return { waitMs: r.cooldownUntil - now }
  }
  while (s.queue.length > 0) {
    const item = s.queue[0]
    const reason = skipReason(s, item)
    if (!reason) {
      const { delayMs, jitterMs } = s.settings
      return { item, delayMs: delayMs + Math.floor(Math.random() * jitterMs) }
    }
    s.queue.shift()
    countBatch(s, item, 'skipped')
    r.skipped++
    log(s, 'info', `Skipped ${label(item)}: ${reason}`)
  }
  r.state = 'idle'
  const undone = r.unblocked ? `${r.unblocked} unblocked, ` : ''
  r.message = `Done. ${r.done} blocked, ${undone}${r.failed} failed, ${r.skipped} skipped`
  log(s, 'info', r.message)
  return { stop: true }
}

function applyResult(s, msg) {
  const { item, outcome } = msg
  const r = s.runner
  const now = Date.now()
  if (outcome === 'blocked') {
    r.strikes = 0
    removeFromQueue(s, item)
    s.blocked[item.id] = compact({
      id: item.id, screenName: item.screenName ?? knownUser(s, item.id)?.screenName,
      name: knownUser(s, item.id)?.name, at: now, source: 'x-blocker', reason: item.source, batch: item.batch,
    })
    countBatch(s, item, 'done')
    markBlocking(s, item.id)
    s.blockTimes.push(now)
    r.done++
    log(s, 'ok', `Blocked ${label(item)}${item.source ? ` · ${item.source}` : ''}`)
    return { stop: false }
  }
  if (outcome === 'unblocked') {
    r.strikes = 0
    removeFromQueue(s, item)
    delete s.blocked[item.id]
    markBlocking(s, item.id, false)
    // Unblocks are requests to X too, so they count toward the same limits.
    s.blockTimes.push(now)
    r.unblocked = (r.unblocked ?? 0) + 1
    countBatch(s, item, 'done')
    log(s, 'ok', `Unblocked ${label(item)}`)
    return { stop: false }
  }
  if (outcome === 'skipped') {
    removeFromQueue(s, item)
    countBatch(s, item, 'skipped')
    r.skipped++
    log(s, 'info', `Skipped ${label(item)}: ${msg.reason}`)
    return { stop: false }
  }
  const err = msg.error ?? {}
  if (err.code === 'rate_limit') {
    // X reports when its 15-minute window resets; wait exactly that long
    // (plus a few seconds). Only without that header, or after repeated
    // limits in a row, fall back to our own backoff: 15 → 30 → … → 240 min.
    r.strikes = (r.strikes ?? 0) + 1
    const backoff = Math.min(s.settings.cooldownMin * 2 ** (r.strikes - 1), MAX_COOLDOWN_MIN) * 60_000
    const told = err.retryAt ? err.retryAt + RESET_SLACK_MS : 0
    r.state = 'cooldown'
    r.limit = err.scope === 'lookup' ? 'lookup' : 'block'
    r.cooldownUntil = told && r.strikes <= TRUST_RESET_STRIKES ? told : Math.max(told, now + backoff)
    const what = r.limit === 'lookup' ? 'X is limiting account lookups' : 'X is limiting blocks'
    r.message = `${what}. Resuming at ${new Date(r.cooldownUntil).toLocaleTimeString()}`
    log(s, 'warn', r.message)
    return { stop: false }
  }
  if (err.code === 'auth' || err.code === 'forbidden') {
    // Logged out, locked or challenged: never keep firing requests at X.
    r.state = 'error'
    r.message = err.message
    log(s, 'error', `Stopped: ${err.message}`)
    return { stop: true }
  }
  const queued = s.queue.find((q) => itemKey(q) === itemKey(item) ||
    (item.screenName && q.screenName?.toLowerCase() === item.screenName.toLowerCase()))
  const retryable = err.code === 'timeout' || err.code === 'http' || err.code === 'error'
  if (queued && retryable && ++queued.tries < MAX_TRIES) {
    s.queue.push(s.queue.splice(s.queue.indexOf(queued), 1)[0])
    log(s, 'warn', `Will retry ${label(item)}: ${err.message}`)
    return { stop: false }
  }
  removeFromQueue(s, item)
  countBatch(s, item, 'failed')
  r.failed++
  log(s, 'error', `Failed ${label(item)}: ${err.message}`)
  return { stop: false }
}

// ---- messaging ----------------------------------------------------------------

function summary(s) {
  const runner = { ...s.runner }
  if ((runner.state === 'running' || runner.state === 'cooldown') && !runnerAlive(runner)) {
    runner.state = 'paused'
    runner.message = 'The x.com tab stopped responding. Press Start to resume.'
  }
  delete runner.token
  return {
    settings: s.settings,
    runner,
    counts: {
      legacyCollected: pendingCollected(s).length,
      queue: s.queue.length,
      blocked: Object.keys(s.blocked).length,
      last24h: last24h(s),
      lastHour: s.blockTimes.filter((t) => Date.now() - t < HOUR).length,
      etaMs: estimateMs(s),
    },
    // The batch being worked on (the head of the queue), for status displays.
    current: s.queue[0]?.batch && s.batches[s.queue[0].batch]
      ? { source: s.batches[s.queue[0].batch].source, action: s.batches[s.queue[0].batch].action } : null,
  }
}

// Rough time to finish the queue at the configured pace and safety limits.
function estimateMs(s) {
  const left = s.queue.length
  if (!left) return 0
  const { delayMs, jitterMs, hourlyCap, dailyCap } = s.settings
  const now = Date.now()
  const perItem = delayMs + jitterMs / 2 + 1500 // + the request itself
  const perHour = Math.min(hourlyCap || Infinity, HOUR / perItem)
  const wait = s.runner.state === 'cooldown' ? Math.max(0, (s.runner.cooldownUntil ?? now) - now) : 0
  let eta = wait + (left / perHour) * HOUR
  const dayLeft = dailyCap ? Math.max(0, dailyCap - last24h(s)) : Infinity
  if (left > dayLeft) eta = Math.max(eta, Math.ceil((left - dayLeft) / dailyCap) * DAY)
  return Math.round(eta)
}

const contentHandlers = {
  'runner:next': (s, msg) => mutate(s, ['queue', 'runner', 'log', 'blockTimes', 'batches'], () => nextItem(s, msg.token)),
  'runner:check': (s, msg) => ({ skip: skipReason(s, msg.item) }),
  'runner:result': (s, msg) =>
    mutate(s, ['queue', 'runner', 'log', 'blocked', 'blockTimes', 'collected', 'batches'], () => {
      const res = applyResult(s, msg)
      if ((msg.outcome === 'blocked' || msg.outcome === 'unblocked') && msg.item.screenName) {
        browser.tabs.sendMessage(s.runner.tabId, {
          type: msg.outcome === 'blocked' ? 'page:blockedNotice' : 'page:unblockedNotice',
          screenName: msg.item.screenName,
        }).catch(() => {})
      }
      return res
    }),
  'runner:fatal': (s, msg) => mutate(s, ['runner', 'log'], () => {
    if (msg.token && msg.token !== s.runner.token) return {}
    s.runner.state = 'error'
    s.runner.message = msg.error?.message ?? 'Something went wrong. Press Start to try again.'
    log(s, 'error', s.runner.message)
    return {}
  }),
}

const uiHandlers = {
  'state:get': (s) => summary(s),
  'data:get': (s, msg) => {
    const out = summary(s)
    for (const k of msg.keys ?? []) {
      if (k === 'batches') out.batches = batchList(s)
      else if (k in DEFAULTS && k !== 'runner') out[k] = s[k]
    }
    return out
  },
  'settings:set': (s, msg) => mutate(s, ['settings'], () => {
    const patch = msg.patch ?? {}
    for (const k of Object.keys(DEFAULT_SETTINGS)) {
      if (!(k in patch)) continue
      const def = DEFAULT_SETTINGS[k]
      if (Array.isArray(def)) {
        s.settings[k] = [...new Set((patch[k] ?? []).map((x) => String(x).replace(/^@/, '').toLowerCase()).filter(Boolean))]
      } else if (typeof def === 'number') {
        const n = Math.round(Number(patch[k]))
        if (Number.isFinite(n)) s.settings[k] = Math.max(MIN[k] ?? 0, n)
      } else if (typeof def === 'boolean') s.settings[k] = Boolean(patch[k])
      else if (CHOICES[k]?.includes(patch[k])) s.settings[k] = patch[k]
    }
    return summary(s)
  }),
  'settings:reset': (s) => mutate(s, ['settings'], () => {
    // The never-block list is the user's own data, not a preference: keep it.
    s.settings = { ...structuredClone(DEFAULT_SETTINGS), whitelist: s.settings.whitelist, version: SETTINGS_VERSION }
    return summary(s)
  }),
  'queue:add': (s, msg) => mutate(s, ['queue', 'batches'], () => addToQueue(s, msg.items ?? [], 'block', msg.source)),
  'queue:remove': (s, msg) => mutate(s, ['queue', 'batches'], () => {
    const keys = new Set(msg.keys ?? [])
    cancelWhere(s, (q) => keys.has(itemKey(q)))
    return {}
  }),
  'queue:clear': (s) => mutate(s, ['queue', 'batches'], () => { cancelWhere(s, () => true); return {} }),
  // Cancel what is still waiting in a batch; what was already done stays done.
  'batch:cancel': (s, msg) => mutate(s, ['queue', 'batches'], () => ({ cancelled: cancelWhere(s, (q) => q.batch === msg.id) })),
  // Forget a finished batch (the accounts it blocked stay blocked and listed).
  'batch:forget': (s, msg) => mutate(s, ['batches', 'blocked'], () => {
    if (s.queue.some((q) => q.batch === msg.id)) return { error: 'Cancel this batch or let it finish first' }
    delete s.batches[msg.id]
    for (const b of Object.values(s.blocked)) if (b.batch === msg.id) delete b.batch
    return {}
  }),
  // One-time choice for what is left in the old Collected list.
  'legacy:queue': (s) => mutate(s, ['queue', 'collected', 'batches'], () => {
    const res = addToQueue(s, pendingCollected(s).map((u) => ({
      id: u.id, screenName: u.screenName, source: u.sources?.at(-1) ?? 'Collected list',
    })), 'block', 'Your old collected list')
    s.collected = {}
    snIndex = null
    return res
  }),
  'legacy:discard': (s) => mutate(s, ['collected'], () => { s.collected = {}; snIndex = null; return {} }),
  'blocked:clear': (s) => mutate(s, ['blocked', 'batches'], () => {
    s.blocked = {}
    // Finished batches are only history of those blocks; waiting ones stay.
    const waiting = new Set(s.queue.map((q) => q.batch))
    for (const id of Object.keys(s.batches)) if (!waiting.has(id)) delete s.batches[id]
    return {}
  }),
  'log:clear': (s) => mutate(s, ['log'], () => { s.log = []; return {} }),
  // Privacy: wipe everything the extension stored (settings are kept).
  'data:wipe': (s) => mutate(s, ['collected', 'blocked', 'log', 'blockTimes', 'queue', 'runner', 'batches'], () => {
    s.collected = {}
    s.batches = {}
    s.blocked = {}
    s.log = []
    s.blockTimes = []
    s.queue = []
    s.runner = { ...DEFAULT_RUNNER }
    seen.clear()
    browser.storage.session?.remove('seen').catch(() => {})
    snIndex = null
    return {}
  }),
  'runner:pause': (s) => mutate(s, ['runner', 'log'], () => {
    if (s.runner.state === 'running' || s.runner.state === 'cooldown') {
      s.runner.state = 'paused'
      s.runner.message = 'Paused'
      log(s, 'info', 'Paused')
    }
    return summary(s)
  }),
}

async function mutate(s, keys, fn) {
  const result = fn()
  updateBadge(s)
  await save(...keys)
  return result
}

// Requests from the in-page UI (content/page-ui.js) on any x.com tab.
const pageHandlers = {
  'page:config': (s) => ({
    blockButtons: s.settings.blockButtons,
    blockedScreenNames: Object.values(s.blocked).map((b) => b.screenName?.toLowerCase()).filter(Boolean),
  }),
  'page:lookup': (s, msg) => {
    const out = {}
    const queued = queueKeys(s.queue)
    for (const raw of (msg.screenNames ?? []).slice(0, 5000)) {
      const u = bySn(s, raw)
      if (!u) {
        // Queued by handle before X showed us the account: still worth reporting.
        if (isQueued({ screenName: String(raw) }, queued)) out[String(raw).toLowerCase()] = { queued: true }
        continue
      }
      out[u.screenName.toLowerCase()] = {
        id: u.id, name: u.name, avatar: u.avatar, verified: u.verified,
        followers: u.followers, followingCount: u.followingCount,
        following: u.following, followedBy: u.followedBy,
        blocking: typeof u.blocking === 'boolean' ? u.blocking : Boolean(s.blocked[u.id]),
        queued: isQueued(u, queued),
      }
    }
    return out
  },
  'page:viewer': (s, msg) => ({ screenName: knownUser(s, String(msg.id))?.screenName ?? null }),
  'page:progress': () => progressPayload(),
  // Takes accounts back out of the block queue (by ID or handle).
  'page:unqueue': (s, msg) => mutate(s, ['queue', 'batches'], () => {
    const keys = new Set()
    for (const it of Array.isArray(msg.items) ? msg.items.slice(0, 5000) : []) {
      const id = String(it?.id ?? '')
      const sn = String(it?.screenName ?? '')
      if (/^\d{1,20}$/.test(id)) keys.add(itemKey({ id }))
      if (/^[A-Za-z0-9_]{1,15}$/.test(sn)) keys.add(itemKey({ screenName: sn }))
    }
    const removed = []
    cancelWhere(s, (q) => {
      const hit = keys.has(itemKey(q)) || Boolean(q.screenName && keys.has(itemKey({ screenName: q.screenName })))
      if (hit) removed.push(q.screenName ?? knownUser(s, q.id)?.screenName ?? q.id)
      return hit
    })
    return { removed }
  }),
  // Undo right after Block on the page: cancel what is still waiting in that batch.
  'page:cancelBatch': (s, msg) => mutate(s, ['queue', 'batches'], () => {
    const b = s.batches[msg.id]
    if (!b) return { cancelled: 0, done: 0 }
    return { cancelled: cancelWhere(s, (q) => q.batch === msg.id), done: b.done }
  }),
  // Quick blocks count toward the same safety limits as the queue.
  'page:quota': (s) => {
    const used = last24h(s)
    const cap = s.settings.dailyCap
    const hourly = s.settings.hourlyCap
    const usedHour = s.blockTimes.filter((t) => Date.now() - t < HOUR).length
    const limit = cap > 0 && used >= cap ? 'daily' : hourly > 0 && usedHour >= hourly ? 'hourly' : ''
    const paceMs = s.settings.delayMs + s.settings.jitterMs / 2 + 1500
    return { used, cap, usedHour, hourly, limit, allowed: !limit, paceMs }
  },
  'page:blocked': (s, msg) => mutate(s, ['blocked', 'collected', 'blockTimes', 'log', 'queue', 'batches'], () => {
    const { id, screenName } = msg.user ?? {}
    if (!/^\d+$/.test(String(id))) return {}
    const batch = quickBatch(s)
    batch.total++
    batch.done++
    s.blocked[id] = compact({ id, screenName, name: knownUser(s, id)?.name, at: Date.now(), source: 'x-blocker', reason: 'Quick block', batch: batch.id })
    markBlocking(s, id)
    s.blockTimes.push(Date.now())
    removeFromQueue(s, { id, screenName })
    log(s, 'ok', `Blocked @${screenName} (quick block)`)
    return {}
  }),
}

onMessage((msg, sender) => {
  if (sender.id !== browser.runtime.id || typeof msg?.type !== 'string') return undefined
  if (sender.url?.startsWith('https://x.com/')) {
    if (msg.type === 'capture:body') {
      // Chrome path: bodies relayed from the page; same privacy filter as Firefox.
      if (typeof msg.url === 'string' && typeof msg.text === 'string' &&
        msg.text.length <= MAX_BODY && isCapturable(msg.url)) {
        collectFromText(msg.text)
      }
      return undefined
    }
    if (msg.type === 'page:massBlock') return massQueue(sender.tab.id, msg.items)
    // A Block button on the page: the same paced queue, but today's clicks share
    // one "Quick blocks" batch so they can be undone together from the dashboard.
    if (msg.type === 'page:quickBlock') return massQueue(sender.tab.id, msg.items, 'block', 'Quick blocks', quickBatchId())
    if (msg.type === 'page:pause') return exclusive((s) => uiHandlers['runner:pause'](s))
    if (msg.type === 'page:resume') {
      return startRunner(sender.tab.id).then(() => ({ ok: true }), (e) => ({ error: String(e.message ?? e) }))
    }
    if ((msg.type === 'page:lookup') && collectBuffer.size) {
      // Include users captured from responses that haven't been flushed yet.
      return flushCollected().then(() => exclusive((s) => pageHandlers[msg.type](s, msg)))
    }
    if (pageHandlers[msg.type]) return exclusive((s) => pageHandlers[msg.type](s, msg))
    const h = contentHandlers[msg.type]
    if (!h || !sender.tab) return undefined
    return exclusive((s) => {
      if (sender.tab.id !== s.runner.tabId) return { stop: true }
      return h(s, msg)
    })
  }
  if (msg.type === 'runner:start') return startRunner(msg.tabId).then(() => exclusive(summary))
  if (msg.type === 'blocked:unblock') return massQueue(null, msg.items, 'unblock', msg.source)
  if (msg.type === 'batch:unblock') {
    // Undo a whole batch: unblock every account it blocked that is still blocked.
    return exclusive((s) => {
      const b = s.batches[msg.id]
      const items = Object.values(s.blocked).filter((r) => r.batch === msg.id)
        .map((r) => ({ id: r.id, screenName: r.screenName, source: r.reason }))
      return { items, source: b ? `Undo: ${b.source}` : 'Undo' }
    }).then(({ items, source }) => massQueue(null, items, 'unblock', source))
  }
  if (msg.type === 'collect:flush') return flushCollected().then(() => exclusive(summary))
  const h = uiHandlers[msg.type]
  return h ? exclusive((s) => h(s, msg)) : undefined
})

// Queues accounts and makes sure the runner is going. Unblocks requested from
// the dashboard have no tab of their own: the runner picks (or opens) an x.com tab.
async function massQueue(tabId, items, action = 'block', source, batchId) {
  const { added, skipped, active, batch } = await exclusive((s) => mutate(s, ['queue', 'batches'], () => ({
    ...addToQueue(s, items ?? [], action, source, batchId),
    active: (s.runner.state === 'running' || s.runner.state === 'cooldown') && runnerAlive(s.runner),
  })))
  // The accounts are queued whether or not the run can start now: a tab that
  // isn't reachable only means it waits until one is.
  let error
  if (!active && (added || tabId != null)) {
    try {
      await startRunner(tabId ?? undefined)
    } catch (e) {
      error = String(e.message ?? e)
    }
  }
  return error ? { added, skipped, batch, error } : { added, skipped, batch }
}

browser.tabs.onRemoved.addListener((tabId) => {
  exclusive(async (s) => {
    if (s.runner.tabId !== tabId) return
    if (s.runner.state === 'running' || s.runner.state === 'cooldown') {
      s.runner.state = 'paused'
      s.runner.message = 'The x.com tab was closed. Press Start to resume.'
      log(s, 'warn', s.runner.message)
      updateBadge(s)
      await save('runner', 'log')
    }
  })
})

load().then(updateBadge)
