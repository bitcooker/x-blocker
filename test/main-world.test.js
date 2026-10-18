// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../extension/content/main-world.js', import.meta.url), 'utf8')
const ENTRY = 'https://abs.twimg.com/x-web/x-web/entry-client-abc.js'
const STARTUP = 'https://abs.twimg.com/x-web/x-web/assets/startup-def.js'
const BLOCK_CHUNK = 'https://abs.twimg.com/x-web/x-web/assets/block-user-XyZ12.js'

function createPage(apiHandler) {
  const listeners = []
  let pageWindow
  const requests = []
  const assets = {
    [ENTRY]: 'import"./assets/startup-def.js";m.f=["assets/block-user-XyZ12.js"]',
    [STARTUP]: 'n.set(`Authorization`,`Bearer AAAAAAAAAAAAAAAAAAAAAtestBearer%3Dxyz`);' +
      'params:{id:`resolveId1`,metadata:{},name:`intentFollowUserByScreenNameQuery`,operationKind:`query`}',
    [BLOCK_CHUNK]: 'params:{id:`blockId9`,metadata:{},name:`blockUserMutation`,operationKind:`mutation`}',
  }
  const ctx = {
    console: { warn() {}, log() {}, error() {} },
    URL, URLSearchParams, Headers, Object, JSON, Promise, RegExp, Error, String, Number, Boolean,
    location: { origin: 'https://x.com' },
    sessionStorage: { getItem: () => null, setItem() {} },
    performance: { getEntriesByType: () => [{ name: STARTUP }] },
    document: {
      cookie: 'ct0=csrf123; twid=u%3D777',
      documentElement: { lang: 'en' },
      querySelector: () => null,
      querySelectorAll: (sel) => (sel === 'script[src]' ? [{ src: ENTRY }] : []),
    },
    addEventListener: (type, fn) => type === 'message' && listeners.push(fn),
    postMessage(data) {
      queueMicrotask(() => listeners.forEach((fn) => fn({ source: pageWindow, origin: 'https://x.com', data })))
    },
    async fetch(url, init = {}) {
      if (assets[url]) return { ok: true, text: async () => assets[url] }
      requests.push({ url, init })
      const { status = 200, body } = apiHandler(url, init)
      return { ok: status < 400, status, headers: new Headers(), json: async () => body }
    },
  }
  ctx.window = ctx
  vm.createContext(ctx)
  // Inside the context, `window` is the contextified global, not `ctx`.
  pageWindow = vm.runInContext('window', ctx)
  vm.runInContext(source, ctx)

  let seq = 0
  const call = (cmd, args) => new Promise((resolve) => {
    const id = `t${++seq}`
    listeners.push(({ data }) => {
      if (data.__x_blocker__ === 'response' && data.id === id) resolve(data)
    })
    ctx.postMessage({ __x_blocker__: 'request', id, cmd, args })
  })
  return { call, requests }
}

test('block discovers the mutation id from a lazy chunk and sends the x-web request', async () => {
  const page = createPage(() => ({
    body: { data: { block_by_rest_id: { __typename: 'BlockSuccessResult' } } },
  }))
  const res = await page.call('block', { userId: '123' })
  assert.equal(res.ok, true, JSON.stringify(res.error))
  const [req] = page.requests
  assert.equal(req.url, 'https://api.x.com/graphql/blockId9/blockUserMutation')
  assert.equal(req.init.method, 'POST')
  assert.equal(req.init.credentials, 'include')
  assert.deepEqual(JSON.parse(req.init.body), { queryId: 'blockId9', variables: { targetUserId: '123' } })
  assert.equal(req.init.headers.get('x-csrf-token'), 'csrf123')
  assert.equal(req.init.headers.get('authorization'), 'Bearer AAAAAAAAAAAAAAAAAAAAAtestBearer%3Dxyz')
})

test('resolve uses the screen-name query', async () => {
  const page = createPage(() => ({
    body: { data: { user_result_by_screen_name: { result: { rest_id: '55', core: { screen_name: 'Bob' } } } } },
  }))
  const res = await page.call('resolve', { screenName: 'bob' })
  assert.deepEqual({ ...res.result }, { id: '55', screenName: 'Bob' })
  const url = new URL(page.requests[0].url)
  assert.equal(url.pathname, '/graphql/resolveId1/intentFollowUserByScreenNameQuery')
  assert.deepEqual(JSON.parse(url.searchParams.get('variables')), { screenName: 'bob' })
})

test('maps rate limits and refuses to block yourself', async () => {
  const page = createPage(() => ({ status: 429, body: {} }))
  const limited = await page.call('block', { userId: '1' })
  assert.equal(limited.error.code, 'rate_limit')
  const self = await page.call('block', { userId: '777' })
  assert.equal(self.error.code, 'invalid')
})

test('rate limits say whether lookups or blocks were limited', async () => {
  const page = createPage(() => ({ status: 429, body: {} }))
  assert.equal((await page.call('resolve', { screenName: 'bob' })).error.scope, 'lookup')
  assert.equal((await page.call('block', { userId: '1' })).error.scope, 'block')
})

test('unblock posts the account ID to the REST unblock endpoint', async () => {
  const page = createPage(() => ({ body: { id_str: '123', screen_name: 'oops' } }))
  const res = await page.call('unblock', { userId: '123' })
  assert.equal(res.ok, true, JSON.stringify(res.error))
  const [req] = page.requests
  assert.equal(req.url, 'https://api.x.com/1.1/blocks/destroy.json')
  assert.equal(req.init.method, 'POST')
  assert.equal(req.init.headers.get('content-type'), 'application/x-www-form-urlencoded')
  assert.equal(req.init.body, 'user_id=123')

  const limited = createPage(() => ({ status: 429, body: {} }))
  const err = await limited.call('unblock', { userId: '1' })
  assert.deepEqual([err.error.code, err.error.scope], ['rate_limit', 'block'])
})
