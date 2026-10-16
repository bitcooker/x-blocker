// SPDX-License-Identifier: GPL-3.0-or-later
// Chrome only (Firefox reads responses passively with webRequest.filterResponseData).
// Chrome MV3 offers no API to read response bodies, so this MAIN-world script,
// injected at document_start before X's code, observes X's GraphQL responses:
// it clones a response, never alters it, and forwards the JSON text to the
// isolated bridge. Private traffic (DMs, chat, notifications, account data…)
// is skipped before any body is read.
(() => {
  'use strict'

  const TAG = '__x_blocker__'
  const MAX_BODY = 5 * 1024 * 1024
  const API_URL_RE = /^https:\/\/(?:api\.x\.com\/graphql\/|x\.com\/i\/api\/graphql\/)/
  const PRIVATE_OPS = /dm|chat|inbox|message|conversationlist|notification|bookmark|account|setting|grok|money|payment|password|email|phone|session|passkey|login|verification|delegate/i

  function wanted(url) {
    try {
      const u = new URL(url, location.href)
      return API_URL_RE.test(u.href) && !PRIVATE_OPS.test(u.pathname.split('/').pop() ?? '')
    } catch {
      return false
    }
  }

  function forward(url, text) {
    if (typeof text === 'string' && text.length > 0 && text.length <= MAX_BODY) {
      window.postMessage({ [TAG]: 'capture', url, text }, location.origin)
    }
  }

  const nativeFetch = window.fetch
  window.fetch = function fetch(input, init) {
    const promise = nativeFetch.apply(this, arguments)
    try {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url
      if (url && wanted(url)) {
        promise.then((res) => {
          const type = res.headers.get('content-type') ?? ''
          const length = Number(res.headers.get('content-length') ?? 0)
          if (!res.ok || !type.includes('json') || length > MAX_BODY) return
          res.clone().text().then((text) => forward(res.url || url, text), () => {})
        }, () => {})
      }
    } catch {
      // Observation must never interfere with the page's own request.
    }
    return promise
  }

  const xhrUrls = new WeakMap()
  const { open, send } = XMLHttpRequest.prototype
  XMLHttpRequest.prototype.open = function (method, url) {
    try { xhrUrls.set(this, String(url)) } catch {}
    return open.apply(this, arguments)
  }
  XMLHttpRequest.prototype.send = function () {
    const url = xhrUrls.get(this)
    if (url && wanted(url)) {
      this.addEventListener('load', () => {
        try {
          if (this.status < 200 || this.status >= 300) return
          if (this.responseType === '' || this.responseType === 'text') forward(url, this.responseText)
          else if (this.responseType === 'json' && this.response) forward(url, JSON.stringify(this.response))
        } catch {}
      })
    }
    return send.apply(this, arguments)
  }
})()
