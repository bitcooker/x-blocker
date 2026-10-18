// SPDX-License-Identifier: GPL-3.0-or-later
// Runs the real background.js against an in-memory fake of the extension API
// and drives it with the same messages the content scripts send.
import { test } from 'node:test'
import assert from 'node:assert/strict'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const store = { local: {}, session: {} }
let listener = null

const area = (name) => ({
  get: async (keys) => {
    const all = store[name]
    if (keys == null) return { ...all }
    const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys)
    return Object.fromEntries(list.filter((k) => k in all).map((k) => [k, structuredClone(all[k])]))
  },
  set: async (obj) => { Object.assign(store[name], structuredClone(obj)) },
  remove: async (k) => { delete store[name][k] },
})

globalThis.browser = {
  runtime: {
    id: 'ext',
    onMessage: { addListener: (f) => { listener = f } },
    sendMessage: async () => {},
    getURL: (p) => `moz-extension://ext/${p}`,
  },
  storage: { local: area('local'), session: area('session') },
  action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
  tabs: { query: async () => [], sendMessage: async () => {}, onRemoved: { addListener() {} } },
}

let instance = 0
// Fresh background instance on top of the given stored state.
async function boot(local = {}) {
  store.local = structuredClone(local)
  store.session = {}
  await import(`../extension/background.js?instance=${++instance}`)
  await sleep(50)
}

const X_TAB = { id: 'ext', url: 'https://x.com/someone/followers', tab: { id: 7 } }
function send(msg, sender = X_TAB) {
  return new Promise((resolve) => {
    const async = listener(msg, sender, resolve)
    if (!async) resolve(undefined)
  })
}

const user = (id, sn, rel = {}) => ({
  __typename: 'User', rest_id: id, core: { screen_name: sn, name: sn.toUpperCase() },
  relationship_perspectives: { following: false, followed_by: false, blocking: false, ...rel },
})
const response = (...users) => ({
  type: 'capture:body',
  url: 'https://api.x.com/graphql/abc/followersQuery',
  text: JSON.stringify({ data: { list: users.map((u) => ({ user_results: { result: u } })) } }),
})

const DASH = { id: 'ext', url: 'moz-extension://ext/dashboard/dashboard.html' }

test('accounts X shows are only kept in the session cache', async () => {
  await boot()
  await send(response(user('1', 'friend', { following: true }), user('2', 'spammer')))
  await sleep(1300) // capture buffer flush
  await sleep(2200) // debounced writes
  assert.deepEqual(store.local.collected ?? {}, {})
  assert.deepEqual(store.session.seen.map((u) => u.screenName).sort(), ['friend', 'spammer'])

  // The session cache still powers lookups and the friend check.
  const info = await send({ type: 'page:lookup', screenNames: ['friend', 'spammer'] })
  assert.equal(info.friend.following, true)
  assert.equal(info.spammer.id, '2')
  assert.equal(await send({ type: 'page:collect', screenNames: ['spammer'] }), undefined)
})

test('upgrading drops the collecting settings and keeps the rest', async () => {
  await boot({
    settings: { version: 2, collect: true, collectAlways: true, autoScroll: true, delayMs: 5000 },
    collected: { 9: { id: '9', screenName: 'old_friend', seenAt: Date.now() } },
    queue: [{ id: '5', addedAt: 1, tries: 0 }],
  })
  await send({ type: 'page:config' })
  assert.deepEqual(store.local.collected, {})
  assert.equal(store.local.settings.version, 5)
  assert.equal('collectAlways' in store.local.settings, false)
  assert.equal('collect' in store.local.settings, false)
  assert.equal('autoScroll' in store.local.settings, false)
  assert.equal(store.local.settings.delayMs, 5000)
  assert.equal(store.local.queue.length, 1)
})

test('content scripts cannot call dashboard actions', async () => {
  await boot()
  assert.equal(await send({ type: 'data:wipe' }), undefined)
  assert.equal(await send({ type: 'settings:set', patch: { inPageButtons: false } }), undefined)
  assert.equal(await send({ type: 'legacy:queue' }), undefined)
})

test('the old Collected list can be queued or discarded once', async () => {
  const now = Date.now()
  const legacy = {
    settings: { version: 4 },
    collected: {
      1: { id: '1', screenName: 'waiting', collectedAt: now, seenAt: now, sources: ['Followers of @a'] },
      2: { id: '2', screenName: 'queued', collectedAt: now, seenAt: now, sources: ['A'] },
      3: { id: '3', screenName: 'done', collectedAt: now, seenAt: now, sources: ['A'] },
    },
    queue: [{ id: '2', screenName: 'queued', addedAt: now, tries: 0 }],
    blocked: { 3: { id: '3', screenName: 'done', at: now } },
  }
  await boot(legacy)
  assert.equal((await send({ type: 'state:get' }, DASH)).counts.legacyCollected, 1)
  const res = await send({ type: 'legacy:queue' }, DASH)
  assert.equal(res.added, 1)
  const { counts, queue } = await send({ type: 'data:get', keys: ['queue'] }, DASH)
  assert.equal(counts.legacyCollected, 0)
  assert.deepEqual(queue.map((q) => [q.screenName, q.source]), [['queued', undefined], ['waiting', 'Followers of @a']])

  await boot(legacy)
  await send({ type: 'legacy:discard' }, DASH)
  assert.equal((await send({ type: 'state:get' }, DASH)).counts.legacyCollected, 0)
  assert.equal((await send({ type: 'data:get', keys: ['queue'] }, DASH)).queue.length, 1)
})

test('blocked accounts can be queued for unblocking and are unblocked by the runner', async () => {
  const now = Date.now()
  await boot({
    settings: { version: 5 },
    blocked: {
      1: { id: '1', screenName: 'oops', at: now, source: 'x-blocker', reason: 'Replies to @a' },
      2: { id: '2', screenName: 'meant_it', at: now, source: 'x-blocker', reason: 'Quick block' },
    },
  })
  // No x.com tab in this fake browser, so starting the runner fails; the unblock stays queued.
  await send({ type: 'blocked:unblock', items: [{ id: '1', screenName: 'oops' }, { id: '99' }] }, DASH)
  const { queue } = await send({ type: 'data:get', keys: ['queue'] }, DASH)
  assert.deepEqual(queue.map((q) => [q.id, q.action]), [['1', 'unblock']], 'only recorded blocks can be unblocked')

  await boot({
    settings: { version: 5 },
    blocked: store.local.blocked,
    queue: store.local.queue,
    runner: { state: 'running', tabId: 7, token: 't', lastBeat: Date.now(), done: 0, failed: 0, skipped: 0, strikes: 0 },
  })
  const next = await send({ type: 'runner:next', token: 't' })
  assert.equal(next.item.action, 'unblock')
  await send({ type: 'runner:result', token: 't', item: next.item, outcome: 'unblocked' })
  const after = await send({ type: 'data:get', keys: ['blocked', 'queue'] }, DASH)
  assert.deepEqual(Object.keys(after.blocked), ['2'])
  assert.equal(after.queue.length, 0)
  assert.equal(after.runner.unblocked, 1)
})

test('a rate limit waits for the reset time X reports, not a fixed cooldown', async () => {
  const now = Date.now()
  await boot({
    queue: [{ screenName: 'spammer' }],
    runner: { state: 'running', tabId: 7, token: 't', lastBeat: now, done: 0, failed: 0, skipped: 0, strikes: 0 },
  })
  const error = { code: 'rate_limit', message: 'Rate limited by X', retryAt: now + 60_000, scope: 'lookup' }
  await send({ type: 'runner:result', token: 't', item: { screenName: 'spammer' }, outcome: 'failed', error })
  const { runner, queueLen } = await send({ type: 'page:progress' })
  assert.equal(runner.state, 'cooldown')
  assert.equal(runner.limit, 'lookup')
  assert.ok(runner.cooldownUntil < now + 2 * 60_000, 'should not wait the 15-minute fallback')
  assert.equal(queueLen, 1, 'the account stays queued')

  // Without a reset time, the configured fallback cooldown applies.
  await send({ type: 'runner:result', token: 't', item: { screenName: 'spammer' }, outcome: 'failed', error: { code: 'rate_limit', scope: 'block' } })
  const after = (await send({ type: 'page:progress' })).runner
  assert.equal(after.limit, 'block')
  assert.ok(after.cooldownUntil >= now + 25 * 60_000)
})

test('v4 moves an untouched old daily limit and keeps custom values', async () => {
  await boot({ settings: { version: 3, delayMs: 4000, jitterMs: 4000, dailyCap: 450 } })
  await send({ type: 'page:config' })
  const st = store.local.settings
  assert.deepEqual([st.version, st.delayMs, st.jitterMs, st.dailyCap, st.hourlyCap], [5, 4000, 4000, 1000, 150])

  await boot({ settings: { version: 3, delayMs: 5000, jitterMs: 4000, dailyCap: 300 } })
  await send({ type: 'page:config' })
  assert.deepEqual([store.local.settings.delayMs, store.local.settings.dailyCap], [5000, 300])
})

test('the hourly limit pauses the queue until the oldest block leaves the hour', async () => {
  const now = Date.now()
  const blockTimes = Array.from({ length: 150 }, (_, i) => now - 50 * 60_000 + i * 1000)
  await boot({
    settings: { version: 4, hourlyCap: 150, dailyCap: 1000 },
    blockTimes,
    queue: [{ screenName: 'spammer' }],
    runner: { state: 'running', tabId: 7, token: 't', lastBeat: now, done: 0, failed: 0, skipped: 0, strikes: 0 },
  })
  const next = await send({ type: 'runner:next', token: 't' })
  assert.ok(next.waitMs > 9 * 60_000 && next.waitMs <= 10 * 60_000)
  const { runner } = await send({ type: 'page:progress' })
  assert.equal(runner.limit, 'hourly')
  const quota = await send({ type: 'page:quota' })
  assert.equal(quota.allowed, false)
  assert.equal(quota.limit, 'hourly')
})

test('resetting settings restores defaults but keeps the never-block list', async () => {
  await boot({ settings: { version: 5, delayMs: 9000, hourlyCap: 20, inPageButtons: false, whitelist: ['friend'] } })
  assert.equal(await send({ type: 'settings:reset' }), undefined, 'content scripts cannot reset settings')
  await send({ type: 'settings:reset' }, DASH)
  const { settings } = await send({ type: 'data:get', keys: ['settings'] }, DASH)
  assert.deepEqual([settings.delayMs, settings.hourlyCap, settings.inPageButtons], [4000, 150, true])
  assert.deepEqual(settings.whitelist, ['friend'])
})

test('lookup reports queued accounts, and unqueue removes them', async () => {
  await boot({
    settings: { version: 5 },
    queue: [{ id: '2', screenName: 'queued_one', addedAt: 1, tries: 0 }, { screenName: 'by_name', addedAt: 1, tries: 0 }],
  })
  await send(response(user('1', 'kept'), user('2', 'queued_one')))
  await sleep(1300)
  const info = await send({ type: 'page:lookup', screenNames: ['kept', 'queued_one', 'by_name'] })
  assert.equal(info.kept.queued, false)
  assert.equal(info.queued_one.queued, true)
  assert.equal(info.by_name.queued, true)
  const res = await send({ type: 'page:unqueue', items: [{ id: '2' }, { screenName: 'BY_NAME' }] })
  assert.deepEqual(res.removed.sort(), ['by_name', 'queued_one'])
  assert.equal((await send({ type: 'page:progress' })).queueLen, 0)
})

test('each queued group is a batch that counts its outcomes and can be cancelled', async () => {
  await boot({ settings: { version: 5 } })
  const res = await send({ type: 'queue:add', source: 'Replies to @a', items: [{ id: '1', screenName: 'one' }, { id: '2', screenName: 'two' }, { id: '3', screenName: 'three' }] }, DASH)
  assert.equal(res.added, 3)
  const { batches, queue } = await send({ type: 'data:get', keys: ['batches', 'queue'] }, DASH)
  assert.equal(batches.length, 1)
  assert.deepEqual([batches[0].source, batches[0].total, batches[0].waiting], ['Replies to @a', 3, 3])
  assert.ok(queue.every((q) => q.batch === batches[0].id))

  await boot({ settings: { version: 5 }, queue, batches: { [batches[0].id]: { ...batches[0] } },
    runner: { state: 'running', tabId: 7, token: 't', lastBeat: Date.now(), done: 0, failed: 0, skipped: 0, strikes: 0 } })
  const next = await send({ type: 'runner:next', token: 't' })
  await send({ type: 'runner:result', token: 't', item: next.item, outcome: 'blocked' })
  await send({ type: 'batch:cancel', id: next.item.batch }, DASH)
  const after = await send({ type: 'data:get', keys: ['batches', 'queue', 'blocked'] }, DASH)
  assert.deepEqual([after.batches[0].done, after.batches[0].cancelled, after.batches[0].waiting], [1, 2, 0])
  assert.equal(after.queue.length, 0)
  assert.equal(after.blocked['1'].batch, next.item.batch)
})

test('a batch can be undone: its blocked accounts are queued for unblocking', async () => {
  const now = Date.now()
  await boot({
    settings: { version: 5 },
    batches: { b1: { id: 'b1', source: 'Followers of @x', action: 'block', createdAt: now, total: 2, done: 2, skipped: 0, failed: 0, cancelled: 0 } },
    blocked: {
      1: { id: '1', screenName: 'a', at: now, source: 'x-blocker', reason: 'Followers of @x', batch: 'b1' },
      2: { id: '2', screenName: 'b', at: now, source: 'x-blocker', reason: 'Followers of @x', batch: 'b1' },
      3: { id: '3', screenName: 'c', at: now, source: 'x-blocker', reason: 'Quick block' },
    },
  })
  await send({ type: 'batch:unblock', id: 'b1' }, DASH) // no x.com tab here: queued, not started
  const { queue, batches } = await send({ type: 'data:get', keys: ['queue', 'batches'] }, DASH)
  assert.deepEqual(queue.map((q) => [q.id, q.action]), [['1', 'unblock'], ['2', 'unblock']])
  assert.equal(batches[0].source, 'Undo: Followers of @x')
  assert.equal(batches[0].action, 'unblock')
})

test('past blocks and waiting accounts are grouped into batches on upgrade', async () => {
  const day = Date.parse('2026-10-01T12:00:00Z')
  await boot({
    settings: { version: 5 },
    blocked: {
      1: { id: '1', at: day, source: 'x-blocker', reason: 'Followers of @x' },
      2: { id: '2', at: day + 1000, source: 'x-blocker', reason: 'Followers of @x' },
      3: { id: '3', at: day, source: 'x-blocker', reason: 'Quick block' },
      4: { id: '4', at: day, source: 'seen' },
    },
    queue: [{ id: '5', source: 'Imported list', addedAt: day, tries: 0 }],
  })
  const { batches } = await send({ type: 'data:get', keys: ['batches'] }, DASH)
  assert.deepEqual(batches.map((b) => [b.source, b.total, b.waiting]).sort(),
    [['Followers of @x', 2, 0], ['Imported list', 1, 1], ['Quick block', 1, 0]])
  assert.equal(store.local.blocked['4'].batch, undefined, 'accounts X already showed as blocked are not ours to undo')
})

test('quick blocks of a day share one batch', async () => {
  await boot({ settings: { version: 5 } })
  await send({ type: 'page:blocked', user: { id: '1', screenName: 'a' } })
  await send({ type: 'page:blocked', user: { id: '2', screenName: 'b' } })
  const { batches } = await send({ type: 'data:get', keys: ['batches'] }, DASH)
  assert.equal(batches.length, 1)
  assert.deepEqual([batches[0].source, batches[0].done], ['Quick blocks', 2])
})
