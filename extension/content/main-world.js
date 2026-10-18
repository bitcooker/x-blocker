// SPDX-License-Identifier: GPL-3.0-or-later
// Runs in the page's MAIN world on x.com. It never patches page globals; it
// only answers commands from the isolated bridge (content/bridge.js) and
// performs API calls exactly like the x-web client does, reusing X's own
// request-signing module for the x-client-transaction-id header.
(() => {
  'use strict'

  const TAG = '__x_blocker__'
  if (window[TAG]) return
  Object.defineProperty(window, TAG, { value: true })

  const API_ORIGIN = 'https://api.x.com'
  const FALLBACK_BEARER =
    'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA'
  // Last known persisted-query IDs; discovered at runtime when possible.
  const FALLBACK_OPS = {
    blockUserMutation: 'aw6E7Cv9n4AoS9iv5jm-XA',
    intentFollowUserByScreenNameQuery: 'frIPQPuTi1WBHmfe-hRyrA',
  }
  // Lazy chunks that define an operation, for when it is not loaded yet.
  const OP_CHUNK_HINTS = {
    blockUserMutation: /block-user-[\w-]+\.js/,
  }
  const SIGN_CHUNK_RE = /sign\.[A-Za-z0-9]+-[\w-]+\.js/
  const XWEB_SCRIPT_RE = /^https:\/\/abs\.twimg\.com\/x-web\/.+\.js(?:\?|$)/

  const nativeFetch = window.fetch.bind(window)
  const textCache = new Map()

  function cookie(name) {
    const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'))
    return m ? decodeURIComponent(m[1]) : undefined
  }

  function viewerId() {
    return /u=(\d+)/.exec(cookie('twid') ?? '')?.[1]
  }

  function loadedScriptUrls() {
    const urls = new Set()
    for (const s of document.querySelectorAll('script[src]')) urls.add(s.src)
    for (const l of document.querySelectorAll('link[rel="modulepreload"][href]')) urls.add(l.href)
    for (const e of performance.getEntriesByType('resource')) urls.add(e.name)
    // Startup/entry chunks hold the bearer token, chunk map and most query ids:
    // search them first so discovery usually needs only a few downloads.
    const rank = (u) => (/\/(entry|startup)[^/]*\.js/.test(u) ? 0 : 1)
    return [...urls].filter((u) => XWEB_SCRIPT_RE.test(u)).sort((a, b) => rank(a) - rank(b))
  }

  function assetsBase() {
    const any = loadedScriptUrls()[0]
    if (!any) return 'https://abs.twimg.com/x-web/x-web/assets/'
    const u = new URL(any)
    const dir = u.pathname.replace(/[^/]+$/, '')
    return u.origin + (dir.endsWith('/assets/') ? dir : dir + 'assets/')
  }

  function getText(url) {
    if (!textCache.has(url)) {
      const p = nativeFetch(url, { credentials: 'omit' }).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`)
        return r.text()
      })
      p.catch(() => textCache.delete(url))
      textCache.set(url, p)
    }
    return textCache.get(url)
  }

  async function searchLoadedScripts(fn) {
    for (const url of loadedScriptUrls()) {
      let text
      try { text = await getText(url) } catch { continue }
      const hit = fn(text, url)
      if (hit) return hit
    }
    return undefined
  }

  // All lazy chunks live flat in the assets/ directory.
  function chunkUrl(name) {
    return assetsBase() + name.replace(/^.*\//, '')
  }

  function opIdFrom(text, name) {
    const re = new RegExp(
      'params:\\{id:[`"\']([\\w-]+)[`"\'],metadata:\\{[^}]*\\},name:[`"\']' + name + '[`"\']',
    )
    return re.exec(text)?.[1]
  }

  const opIdPromises = new Map()
  function operationId(name) {
    if (!opIdPromises.has(name)) {
      const p = (async () => {
        let id = await searchLoadedScripts((t) => opIdFrom(t, name))
        if (!id && OP_CHUNK_HINTS[name]) {
          const chunk = await searchLoadedScripts((t) => {
            const m = OP_CHUNK_HINTS[name].exec(t)
            return m ? chunkUrl(m[0]) : undefined
          })
          if (chunk) id = opIdFrom(await getText(chunk).catch(() => ''), name)
        }
        return id ?? FALLBACK_OPS[name]
      })()
      p.catch(() => opIdPromises.delete(name))
      opIdPromises.set(name, p)
    }
    return opIdPromises.get(name)
  }

  let bearerPromise
  function bearer() {
    bearerPromise ??= searchLoadedScripts((t) => /Bearer (AAAAAAAAAAAAAAAAAAAAA[\w%-]+)/.exec(t)?.[1])
      .then((b) => b ?? FALLBACK_BEARER, () => FALLBACK_BEARER)
    return bearerPromise
  }

  let signerPromise
  function signer() {
    signerPromise ??= (async () => {
      let url = loadedScriptUrls().find((u) => SIGN_CHUNK_RE.test(u))
      url ??= await searchLoadedScripts((t) => {
        const m = SIGN_CHUNK_RE.exec(t)
        return m ? chunkUrl(m[0]) : undefined
      })
      if (!url) throw new Error('Could not locate X request-signing module')
      // Only ever load X's own first-party signing chunk into X's own page.
      if (!/^https:\/\/abs\.twimg\.com\/x-web\/[\w/-]+\/sign\.[A-Za-z0-9]+-[\w-]+\.js$/.test(url)) {
        throw new Error('Unexpected signing module URL: ' + url)
      }
      const mod = await import(url)
      const sign = await mod.default()
      if (typeof sign !== 'function') throw new Error('Unexpected signing module shape')
      return sign
    })()
    signerPromise.catch(() => { signerPromise = undefined })
    return signerPromise
  }

  class ApiError extends Error {
    constructor(code, message, extra = {}) {
      super(message)
      this.code = code
      Object.assign(this, extra)
    }
  }

  // X limits each endpoint separately, so a 429 says which limit was hit:
  // 'lookup' (resolving @names) or 'block' (the block mutation itself).
  async function api(method, path, { variables, body, scope } = {}) {
    const url = new URL(path, API_ORIGIN)
    if (variables && method === 'GET') url.searchParams.set('variables', JSON.stringify(variables))
    const csrf = cookie('ct0')
    if (!csrf) throw new ApiError('auth', 'Not logged in to x.com (missing ct0 cookie)')
    const headers = new Headers({
      authorization: 'Bearer ' + (await bearer()),
      'content-type': 'application/json',
      'x-csrf-token': csrf,
      'x-twitter-active-user': 'yes',
      'x-twitter-auth-type': 'OAuth2Session',
      'x-twitter-client-language': document.documentElement.lang || 'en',
    })
    try {
      const sign = await signer()
      headers.set('x-client-transaction-id', await sign(url.pathname, method))
    } catch (e) {
      console.warn('[x-blocker] transaction id unavailable:', e)
    }
    const res = await nativeFetch(url.href, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'include',
      mode: 'cors',
    })
    const json = await res.json().catch(() => null)
    const errMsg = json?.errors?.map((e) => e.message).filter(Boolean).join('; ')
    if (res.status === 429) {
      const reset = Number(res.headers.get('x-rate-limit-reset')) * 1000
      const sane = Number.isFinite(reset) && reset > Date.now() && reset < Date.now() + 86_400_000
      throw new ApiError('rate_limit', 'Rate limited by X', { retryAt: sane ? reset : undefined, scope })
    }
    if (res.status === 401) throw new ApiError('auth', errMsg || 'Logged out or session expired (401)')
    // 403 here means the account itself is restricted (locked, challenged, …).
    if (res.status === 403) throw new ApiError('forbidden', errMsg || 'X refused the request (403); check your account')
    if (!res.ok) {
      throw new ApiError(res.status === 404 ? 'not_found' : 'http', errMsg || `HTTP ${res.status}`, {
        status: res.status,
      })
    }
    return json
  }

  async function gql(method, name, variables) {
    const id = await operationId(name)
    const path = `/graphql/${id}/${name}`
    const scope = name === 'blockUserMutation' ? 'block' : 'lookup'
    return method === 'GET'
      ? api('GET', path, { variables, scope })
      : api('POST', path, { body: { queryId: id, variables }, scope })
  }

  const commands = {
    async status() {
      return { loggedIn: Boolean(cookie('ct0') && viewerId()), viewerId: viewerId() }
    },

    async resolve({ screenName }) {
      const json = await gql('GET', 'intentFollowUserByScreenNameQuery', { screenName })
      const r = json?.data?.user_result_by_screen_name?.result
      if (!r?.rest_id) throw new ApiError('not_found', `@${screenName} not found or suspended`)
      return { id: r.rest_id, screenName: r.core?.screen_name ?? screenName }
    },

    async block({ userId }) {
      if (!/^\d+$/.test(String(userId))) throw new ApiError('invalid', 'Invalid user id')
      if (userId === viewerId()) throw new ApiError('invalid', 'Refusing to block yourself')
      const json = await gql('POST', 'blockUserMutation', { targetUserId: String(userId) })
      const typename = json?.data?.block_by_rest_id?.__typename
      if (typename === 'BlockSuccessResult') return { ok: true }
      const codes = (json?.errors ?? []).map((e) => Number(e.code ?? e.extensions?.code))
      const msg = json?.errors?.map((e) => e.message).join('; ') || typename || 'Unknown block response'
      if (codes.includes(88)) throw new ApiError('rate_limit', msg, { scope: 'block' })
      if (codes.some((c) => [32, 64, 215, 326].includes(c))) throw new ApiError('forbidden', msg)
      throw new ApiError(/not.?found|suspend/i.test(msg) ? 'not_found' : 'failed', msg)
    },
  }

  window.addEventListener('message', async (ev) => {
    if (ev.source !== window || ev.origin !== location.origin) return
    const msg = ev.data
    if (!msg || msg[TAG] !== 'request' || typeof msg.id !== 'string') return
    const handler = Object.hasOwn(commands, msg.cmd) ? commands[msg.cmd] : undefined
    let reply
    try {
      if (!handler) throw new ApiError('invalid', `Unknown command ${msg.cmd}`)
      reply = { ok: true, result: await handler(msg.args ?? {}) }
    } catch (e) {
      reply = {
        ok: false,
        error: { code: e.code ?? 'error', message: String(e.message ?? e), retryAt: e.retryAt, scope: e.scope },
      }
    }
    window.postMessage({ [TAG]: 'response', id: msg.id, ...reply }, location.origin)
  })
})()
