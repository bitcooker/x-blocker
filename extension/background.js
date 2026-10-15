// SPDX-License-Identifier: GPL-3.0-or-later
// Background event page: single source of truth for extension state.
// - Captures users from X GraphQL responses (webRequest.filterResponseData),
//   so the page's own JavaScript is never patched.
// - Owns the block queue; an x.com tab (content/bridge.js) executes it and
//   asks for one item at a time, so progress survives reloads and restarts.
import { extractUsers } from './lib/extract-users.js'
import { dedupeItems, itemKey } from './lib/user-list.js'

// Rate limits: X tolerates roughly 500 blocks per rolling 24 h; beyond that it
// starts answering 429 and may force-logout the session. Defaults stay under that
// with headroom for manual blocks, and pace requests like a human (avg ~6 s).
const DEFAULT_SETTINGS = {
  collect: true,
  inPageButtons: true,
  delayMs: 4000,
  jitterMs: 4000,
  cooldownMin: 15,
  dailyCap: 450,
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
  done: 0,
  failed: 0,
  skipped: 0,
  strikes: 0, // consecutive rate limits, for exponential cooldown
}
const DEFAULTS = {
  settings: DEFAULT_SETTINGS,
  collected: {},
  queue: [],
  blocked: {},
  blockTimes: [],
  log: [],
  runner: DEFAULT_RUNNER,
}
const MAX_COLLECTED = 50_000
const COLLECTED_TTL = 30 * 24 * 60 * 60 * 1000 // data minimisation: forget profiles after 30 days
const MAX_COOLDOWN_MIN = 240
const MAX_LOG = 300
const MAX_TRIES = 3
const DAY = 24 * 60 * 60 * 1000
const STALE_MS = 60_000
const API_URLS = [
  'https://api.x.com/graphql/*',
  'https://x.com/i/api/graphql/*',
]
// Never read private traffic (DMs, chat, notifications, account/settings data).
const PRIVATE_OPS = /dm|chat|inbox|message|conversationlist|notification|bookmark|account|setting|grok|money|payment|password|email|phone|session|passkey|login|verification|delegate/i
const SAVE_DEBOUNCE_MS = 2000
const BIG_KEYS = new Set(['collected', 'blocked', 'log', 'blockTimes'])

// ---- state ------------------------------------------------------------------

let cache = null
let lock = Promise.resolve()
let collectEnabled = true

const SETTINGS_VERSION = 2
const MIN = { delayMs: 2000, jitterMs: 0, cooldownMin: 1, dailyCap: 0 }

// v1 shipped with 3 s delay and no daily limit, which can get accounts
// force-logged-out. Move untouched old defaults to the safer ones.
function migrateSettings(st) {
  if ((st.version ?? 1) < 2) {
    if (st.delayMs === 3000) st.delayMs = DEFAULT_SETTINGS.delayMs
    if (st.jitterMs === 2000) st.jitterMs = DEFAULT_SETTINGS.jitterMs
    if (st.dailyCap === 0) st.dailyCap = DEFAULT_SETTINGS.dailyCap
  }
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
    if (stored.settings?.version !== SETTINGS_VERSION) await browser.storage.local.set({ settings: c.settings })
    collectEnabled = c.settings.collect
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
    if (cache && (keys.includes('runner') || keys.includes('queue'))) broadcastProgress()
  }, 250)
}

function progressPayload() {
  const { token, ...runner } = cache.runner
  return { type: 'page:progress', runner, queueLen: cache.queue.length, last24h: last24h(cache) }
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

// screenName (lowercase) -> id, rebuilt lazily after collected changes.
let snIndex = null
function bySn(s, sn) {
  if (!snIndex) {
    snIndex = new Map()
    for (const u of Object.values(s.collected)) snIndex.set(u.screenName.toLowerCase(), u.id)
  }
  const id = snIndex.get(String(sn).toLowerCase())
  return id ? s.collected[id] : undefined
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
      const prev = s.collected[u.id]
      const merged = { ...prev }
      for (const [k, v] of Object.entries(u)) if (v !== undefined && v !== '') merged[k] = v
      merged.seenAt = now
      s.collected[u.id] = merged
      if (u.blocking && !s.blocked[u.id]) {
        s.blocked[u.id] = { id: u.id, screenName: u.screenName, name: u.name, at: now, source: 'seen' }
      } else if (u.blocking === false && s.blocked[u.id]) {
        // X says this account is no longer blocked (unblocked elsewhere).
        delete s.blocked[u.id]
      }
    }
    for (const [id, u] of Object.entries(s.collected)) {
      if (now - (u.seenAt ?? 0) > COLLECTED_TTL) delete s.collected[id]
    }
    snIndex = null
    const ids = Object.keys(s.collected)
    if (ids.length > MAX_COLLECTED) {
      ids.sort((a, b) => s.collected[a].seenAt - s.collected[b].seenAt)
      for (const id of ids.slice(0, ids.length - MAX_COLLECTED)) delete s.collected[id]
    }
    await save('collected', 'blocked')
  })
}

function captureResponse(details) {
  if (!collectEnabled || details.tabId < 0) return
  const op = new URL(details.url).pathname.split('/').pop() ?? ''
  if (PRIVATE_OPS.test(op)) return
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
    if (size <= 20 * 1024 * 1024) chunks.push(e.data)
  }
  filter.onstop = () => {
    filter.close()
    if (size > 20 * 1024 * 1024) return
    try {
      const bytes = new Uint8Array(size)
      let off = 0
      for (const c of chunks) { bytes.set(new Uint8Array(c), off); off += c.byteLength }
      const users = extractUsers(JSON.parse(new TextDecoder().decode(bytes)))
      if (users.length) bufferUsers(users)
    } catch {
      // Not JSON or unexpected shape; nothing to collect.
    }
  }
  filter.onerror = () => {}
}

browser.webRequest.onBeforeRequest.addListener(
  captureResponse,
  { urls: API_URLS, types: ['xmlhttprequest'] },
  ['blocking'],
)

// ---- queue --------------------------------------------------------------------

function findCollected(s, item) {
  if (item.id) return s.collected[item.id]
  return item.screenName ? bySn(s, item.screenName) : undefined
}

function skipReason(s, item) {
  const u = findCollected(s, item)
  const id = item.id ?? u?.id
  const sn = (item.screenName ?? u?.screenName ?? '').toLowerCase()
  if (id && s.blocked[id]) return 'already blocked'
  if (u?.blocking) return 'already blocked'
  if (sn && s.settings.whitelist.includes(sn)) return 'whitelisted'
  if (s.settings.skipFollowing && u?.following) return 'you follow them'
  if (s.settings.skipFollowers && u?.followedBy) return 'they follow you'
  if (s.settings.skipVerified && u?.verified) return 'verified account'
  return null
}

function addToQueue(s, items) {
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
    if (existing.has(itemKey(item)) || (item.id && s.blocked[item.id])) { skipped++; continue }
    existing.add(itemKey(item))
    if (item.screenName) existing.add(itemKey({ screenName: item.screenName }))
    s.queue.push({ ...item, addedAt: Date.now(), tries: 0 })
    added++
  }
  return { added, skipped }
}

function removeFromQueue(s, item) {
  const keys = new Set([itemKey(item)])
  if (item.id && item.screenName) keys.add(itemKey({ screenName: item.screenName }))
  s.queue = s.queue.filter((q) => {
    if (keys.has(itemKey(q))) return false
    return !(q.id && q.screenName && keys.has(itemKey({ screenName: q.screenName })))
  })
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
      state: 'running', tabId: tab.id, token, lastBeat: Date.now(), cooldownUntil: 0, message: '',
      ...(resume ? {} : { done: 0, failed: 0, skipped: 0, strikes: 0 }),
    })
    log(s, 'info', `Started on tab ${tab.id} with ${s.queue.length} queued`)
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
    log(s, 'info', 'Cooldown over, resuming')
  }
  s.blockTimes = s.blockTimes.filter((t) => now - t < DAY)
  if (s.settings.dailyCap > 0 && s.blockTimes.length >= s.settings.dailyCap) {
    r.state = 'cooldown'
    r.cooldownUntil = s.blockTimes[0] + DAY
    r.message = `Daily cap of ${s.settings.dailyCap} reached`
    log(s, 'warn', r.message)
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
    r.skipped++
    log(s, 'info', `Skipped ${label(item)}: ${reason}`)
  }
  r.state = 'idle'
  r.message = `Finished: ${r.done} blocked, ${r.failed} failed, ${r.skipped} skipped`
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
    s.blocked[item.id] = {
      id: item.id, screenName: item.screenName ?? s.collected[item.id]?.screenName,
      name: s.collected[item.id]?.name, at: now, source: 'x-blocker', reason: item.source,
    }
    if (s.collected[item.id]) s.collected[item.id].blocking = true
    s.blockTimes.push(now)
    r.done++
    log(s, 'ok', `Blocked ${label(item)}${item.source ? ` · ${item.source}` : ''}`)
    return { stop: false }
  }
  if (outcome === 'skipped') {
    removeFromQueue(s, item)
    r.skipped++
    log(s, 'info', `Skipped ${label(item)}: ${msg.reason}`)
    return { stop: false }
  }
  const err = msg.error ?? {}
  if (err.code === 'rate_limit') {
    // Back off exponentially on repeated limits: 15 → 30 → 60 → … → 240 min.
    r.strikes = (r.strikes ?? 0) + 1
    const minutes = Math.min(s.settings.cooldownMin * 2 ** (r.strikes - 1), MAX_COOLDOWN_MIN)
    r.state = 'cooldown'
    r.cooldownUntil = Math.max(err.retryAt ?? 0, now + minutes * 60_000)
    r.message = `Rate limited by X, waiting until ${new Date(r.cooldownUntil).toLocaleTimeString()}`
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
  r.failed++
  log(s, 'error', `Failed ${label(item)}: ${err.message}`)
  return { stop: false }
}

// ---- messaging ----------------------------------------------------------------

function summary(s) {
  const runner = { ...s.runner }
  if ((runner.state === 'running' || runner.state === 'cooldown') && !runnerAlive(runner)) {
    runner.state = 'paused'
    runner.message = 'Runner tab stopped responding; press Start to resume'
  }
  delete runner.token
  return {
    settings: s.settings,
    runner,
    counts: {
      collected: Object.keys(s.collected).length,
      queue: s.queue.length,
      blocked: Object.keys(s.blocked).length,
      last24h: last24h(s),
    },
  }
}

const contentHandlers = {
  'runner:next': (s, msg) => mutate(s, ['queue', 'runner', 'log', 'blockTimes'], () => nextItem(s, msg.token)),
  'runner:check': (s, msg) => ({ skip: skipReason(s, msg.item) }),
  'runner:result': (s, msg) =>
    mutate(s, ['queue', 'runner', 'log', 'blocked', 'blockTimes', 'collected'], () => {
      const res = applyResult(s, msg)
      if (msg.outcome === 'blocked' && msg.item.screenName) {
        browser.tabs.sendMessage(s.runner.tabId, { type: 'page:blockedNotice', screenName: msg.item.screenName })
          .catch(() => {})
      }
      return res
    }),
  'runner:fatal': (s, msg) => mutate(s, ['runner', 'log'], () => {
    if (msg.token && msg.token !== s.runner.token) return {}
    s.runner.state = 'error'
    s.runner.message = msg.error?.message ?? 'Runner failed'
    log(s, 'error', s.runner.message)
    return {}
  }),
}

const uiHandlers = {
  'state:get': (s) => summary(s),
  'data:get': (s, msg) => {
    const out = summary(s)
    for (const k of msg.keys ?? []) if (k in DEFAULTS && k !== 'runner') out[k] = s[k]
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
    }
    collectEnabled = s.settings.collect
    return summary(s)
  }),
  'queue:add': (s, msg) => mutate(s, ['queue'], () => addToQueue(s, msg.items ?? [])),
  'queue:addCollected': (s, msg) => mutate(s, ['queue'], () =>
    addToQueue(s, (msg.ids ?? []).map((id) => s.collected[id]).filter(Boolean)
      .map((u) => ({ id: u.id, screenName: u.screenName, source: msg.source ?? 'Selected in dashboard' })))),
  'queue:remove': (s, msg) => mutate(s, ['queue'], () => {
    const keys = new Set(msg.keys ?? [])
    s.queue = s.queue.filter((q) => !keys.has(itemKey(q)))
    return {}
  }),
  'queue:clear': (s) => mutate(s, ['queue'], () => { s.queue = []; return {} }),
  'collected:remove': (s, msg) => mutate(s, ['collected'], () => {
    snIndex = null
    for (const id of msg.ids ?? []) delete s.collected[id]
    return {}
  }),
  'collected:clear': (s) => mutate(s, ['collected'], () => { s.collected = {}; snIndex = null; return {} }),
  'blocked:clear': (s) => mutate(s, ['blocked'], () => { s.blocked = {}; return {} }),
  'log:clear': (s) => mutate(s, ['log'], () => { s.log = []; return {} }),
  // Privacy: wipe everything the extension stored (settings are kept).
  'data:wipe': (s) => mutate(s, ['collected', 'blocked', 'log', 'blockTimes', 'queue', 'runner'], () => {
    s.collected = {}
    s.blocked = {}
    s.log = []
    s.blockTimes = []
    s.queue = []
    s.runner = { ...DEFAULT_RUNNER }
    snIndex = null
    return {}
  }),
  'runner:pause': (s) => mutate(s, ['runner', 'log'], () => {
    if (s.runner.state === 'running' || s.runner.state === 'cooldown') {
      s.runner.state = 'paused'
      s.runner.message = 'Paused'
      log(s, 'info', 'Paused by user')
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
    inPageButtons: s.settings.inPageButtons,
    blockedScreenNames: Object.values(s.blocked).map((b) => b.screenName?.toLowerCase()).filter(Boolean),
  }),
  'page:lookup': (s, msg) => {
    const out = {}
    for (const raw of (msg.screenNames ?? []).slice(0, 5000)) {
      const u = bySn(s, raw)
      if (!u) continue
      out[u.screenName.toLowerCase()] = {
        id: u.id, name: u.name, avatar: u.avatar, verified: u.verified,
        following: u.following, followedBy: u.followedBy,
        blocking: typeof u.blocking === 'boolean' ? u.blocking : Boolean(s.blocked[u.id]),
      }
    }
    return out
  },
  'page:viewer': (s, msg) => ({ screenName: s.collected[String(msg.id)]?.screenName ?? null }),
  'page:progress': () => progressPayload(),
  // Quick blocks count toward the same daily safety limit as the queue.
  'page:quota': (s) => {
    const used = last24h(s)
    const cap = s.settings.dailyCap
    return { used, cap, allowed: cap === 0 || used < cap }
  },
  'page:blocked': (s, msg) => mutate(s, ['blocked', 'collected', 'blockTimes', 'log', 'queue'], () => {
    const { id, screenName } = msg.user ?? {}
    if (!/^\d+$/.test(String(id))) return {}
    s.blocked[id] = { id, screenName, name: s.collected[id]?.name, at: Date.now(), source: 'x-blocker', reason: 'Quick block' }
    if (s.collected[id]) s.collected[id].blocking = true
    s.blockTimes.push(Date.now())
    removeFromQueue(s, { id, screenName })
    log(s, 'ok', `Blocked @${screenName} (quick block)`)
    return {}
  }),
}

browser.runtime.onMessage.addListener((msg, sender) => {
  if (sender.id !== browser.runtime.id || typeof msg?.type !== 'string') return undefined
  if (sender.url?.startsWith('https://x.com/')) {
    if (msg.type === 'page:massBlock') return massBlock(sender.tab.id, msg.items)
    if (msg.type === 'page:pause') return exclusive((s) => uiHandlers['runner:pause'](s))
    if (msg.type === 'page:resume') {
      return startRunner(sender.tab.id).then(() => ({ ok: true }), (e) => ({ error: String(e.message ?? e) }))
    }
    if (msg.type === 'page:lookup' && collectBuffer.size) {
      // Include users captured from responses that haven't been flushed yet.
      return flushCollected().then(() => exclusive((s) => pageHandlers['page:lookup'](s, msg)))
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
  if (msg.type === 'collect:flush') return flushCollected().then(() => exclusive(summary))
  const h = uiHandlers[msg.type]
  return h ? exclusive((s) => h(s, msg)) : undefined
})

async function massBlock(tabId, items) {
  try {
    const { added, skipped, active } = await exclusive((s) => mutate(s, ['queue'], () => ({
      ...addToQueue(s, items ?? []),
      active: (s.runner.state === 'running' || s.runner.state === 'cooldown') && runnerAlive(s.runner),
    })))
    if (!active) await startRunner(tabId)
    return { added, skipped }
  } catch (e) {
    return { error: String(e.message ?? e) }
  }
}

browser.tabs.onRemoved.addListener((tabId) => {
  exclusive(async (s) => {
    if (s.runner.tabId !== tabId) return
    if (s.runner.state === 'running' || s.runner.state === 'cooldown') {
      s.runner.state = 'paused'
      s.runner.message = 'Runner tab was closed; press Start to resume'
      log(s, 'warn', s.runner.message)
      updateBadge(s)
      await save('runner', 'log')
    }
  })
})

load().then(updateBadge)
