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

test('seen accounts are not collected unless the user collects a list', async () => {
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

  const res = await send({ type: 'page:collect', screenNames: ['spammer', 'unknown_yet'], source: 'Followers of @someone' })
  assert.deepEqual(res, { collected: ['spammer'], missing: ['unknown_yet'] })
  await sleep(2200)
  assert.deepEqual(Object.keys(store.local.collected), ['2'])
  assert.deepEqual(store.local.collected['2'].sources, ['Followers of @someone'])
})

test('"always collect" restores automatic collecting', async () => {
  await boot({ settings: { version: 3, collectAlways: true } })
  await send(response(user('3', 'anyone')))
  await sleep(1300 + 2200)
  assert.deepEqual(Object.keys(store.local.collected), ['3'])
  assert.deepEqual(store.local.collected['3'].sources, ['Collected automatically'])
})

test('upgrading clears the auto-collected list and keeps the rest', async () => {
  await boot({
    settings: { version: 2, collect: true, delayMs: 5000 },
    collected: { 9: { id: '9', screenName: 'old_friend', seenAt: Date.now() } },
    queue: [{ id: '5', addedAt: 1, tries: 0 }],
  })
  await send({ type: 'page:config' })
  assert.deepEqual(store.local.collected, {})
  assert.equal(store.local.settings.version, 3)
  assert.equal(store.local.settings.collectAlways, false)
  assert.equal('collect' in store.local.settings, false)
  assert.equal(store.local.settings.delayMs, 5000)
  assert.equal(store.local.queue.length, 1)
})

test('content scripts cannot call dashboard actions', async () => {
  await boot()
  assert.equal(await send({ type: 'data:wipe' }), undefined)
  assert.equal(await send({ type: 'settings:set', patch: { collectAlways: true } }), undefined)
})

test('the Collected list for the page excludes blocked accounts', async () => {
  const now = Date.now()
  await boot({
    settings: { version: 3 },
    collected: {
      1: { id: '1', screenName: 'old', collectedAt: now - 1000, sources: ['A'] },
      2: { id: '2', screenName: 'newer', collectedAt: now, sources: ['B'] },
      3: { id: '3', screenName: 'done', collectedAt: now, sources: ['A'] },
    },
    blocked: { 3: { id: '3', screenName: 'done', at: now } },
  })
  const list = await send({ type: 'page:collectedList' })
  assert.deepEqual(list.map((u) => u.screenName), ['newer', 'old'])
  assert.deepEqual(list[0].sources, ['B'])
  const progress = await send({ type: 'page:progress' })
  assert.equal(progress.collectedCount, 2)
})
