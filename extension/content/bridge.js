// SPDX-License-Identifier: GPL-3.0-or-later
// Isolated-world content script: relays commands between the extension
// (background/popup/dashboard) and the MAIN-world script, and executes the
// block queue while this tab is the active runner.
(() => {
  'use strict'

  const TAG = '__x_blocker__'
  // Firefox: promise-based `browser`; Chrome: promise-based `chrome` (MV3).
  const browser = globalThis.browser ?? globalThis.chrome
  const pending = new Map()
  let seq = 0

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || ev.origin !== location.origin) return
    const msg = ev.data
    if (msg?.[TAG] === 'capture') {
      // Chrome: response bodies from content/capture-hook.js (background re-validates).
      if (typeof msg.url === 'string' && typeof msg.text === 'string') {
        browser.runtime.sendMessage({ type: 'capture:body', url: msg.url, text: msg.text }).catch(() => {})
      }
      return
    }
    if (!msg || msg[TAG] !== 'response' || !pending.has(msg.id)) return
    const { resolve, reject, timer } = pending.get(msg.id)
    clearTimeout(timer)
    pending.delete(msg.id)
    if (msg.ok) resolve(msg.result)
    else reject(Object.assign(new Error(msg.error?.message ?? 'error'), msg.error))
  })

  function callMain(cmd, args, timeoutMs = 30_000) {
    const id = `${Date.now()}-${++seq}-${Math.random().toString(36).slice(2)}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(Object.assign(new Error(`Page did not answer "${cmd}"`), { code: 'timeout' }))
      }, timeoutMs)
      pending.set(id, { resolve, reject, timer })
      window.postMessage({ [TAG]: 'request', id, cmd, args }, location.origin)
    })
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const send = async (msg) => {
    const res = await browser.runtime.sendMessage(msg)
    if (res && typeof res === 'object' && '__error' in res) throw new Error(res.__error)
    return res
  }
  const errInfo = (e) => ({ code: e?.code ?? 'error', message: String(e?.message ?? e), retryAt: e?.retryAt, scope: e?.scope })

  // ---- queue runner -------------------------------------------------------

  let running = false
  let runToken = null
  // The loop's waits end early when the background nudges it (tab:run), e.g.
  // when a cooldown is over but this background tab's timers are throttled.
  let wake = null
  const nap = (ms) => new Promise((resolve) => {
    const done = () => { clearTimeout(timer); wake = null; resolve() }
    const timer = setTimeout(done, ms)
    wake = done
  })

  // Returns { res, blockRequested }. The delay between blocks only matters
  // after a real block request; skipped accounts move on immediately.
  async function processItem(item) {
    let target = item
    if (!target.id) {
      try {
        const r = await callMain('resolve', { screenName: item.screenName })
        // The page channel is shared with X's own scripts; never trust a reply
        // that doesn't match what was asked, so a forged answer can't redirect a block.
        if (!/^\d{1,20}$/.test(String(r?.id)) || String(r?.screenName).toLowerCase() !== item.screenName.toLowerCase()) {
          throw Object.assign(new Error('Unexpected lookup result'), { code: 'invalid' })
        }
        target = { ...item, id: String(r.id), screenName: r.screenName }
      } catch (e) {
        return { res: await send({ type: 'runner:result', item, outcome: 'failed', error: errInfo(e) }) }
      }
      const check = await send({ type: 'runner:check', item: target })
      if (check?.skip) {
        return { res: await send({ type: 'runner:result', item: target, outcome: 'skipped', reason: check.skip }) }
      }
    }
    try {
      if (target.action === 'unblock') {
        await callMain('unblock', { userId: target.id })
        return { blockRequested: true, res: await send({ type: 'runner:result', item: target, outcome: 'unblocked' }) }
      }
      await callMain('block', { userId: target.id })
      return { blockRequested: true, res: await send({ type: 'runner:result', item: target, outcome: 'blocked' }) }
    } catch (e) {
      return { blockRequested: true, res: await send({ type: 'runner:result', item: target, outcome: 'failed', error: errInfo(e) }) }
    }
  }

  // A restart while the loop is sleeping just swaps the token it uses.
  async function runLoop() {
    if (running) return
    running = true
    try {
      const status = await callMain('status', {}, 10_000)
      if (!status.loggedIn) {
        await send({ type: 'runner:fatal', token: runToken, error: { code: 'auth', message: 'Not logged in to x.com in this tab' } })
        return
      }
      for (;;) {
        const next = await send({ type: 'runner:next', token: runToken })
        if (!next || next.stop) break
        if (next.waitMs) {
          await nap(Math.min(next.waitMs, 20_000))
          continue
        }
        const { res, blockRequested } = await processItem(next.item)
        if (res?.stop) break
        // Wait only after an actual block call; a handle lookup that ended in a
        // skip just gets a short breather so lookups aren't fired back to back.
        // The pause after a block is never cut short, so a nudge can't speed blocking up.
        await sleep(blockRequested ? (next.delayMs ?? 4000) : 800)
      }
    } catch (e) {
      await send({ type: 'runner:fatal', token: runToken, error: errInfo(e) }).catch(() => {})
    } finally {
      running = false
    }
  }

  // ---- auto-scroll collector ----------------------------------------------

  let scrolling = false

  function scrollTarget() {
    // A list opened in a modal (list members/followers) scrolls inside the modal.
    const dialog = [...document.querySelectorAll('[role="dialog"]')].pop()
    if (dialog) {
      let best = null
      for (const el of dialog.querySelectorAll('*')) {
        const oy = getComputedStyle(el).overflowY
        if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 50 &&
          (!best || el.scrollHeight > best.scrollHeight)) best = el
      }
      if (best) return best
    }
    const root = document.scrollingElement ?? document.documentElement
    if (root.scrollHeight > root.clientHeight + 50) return root
    let best = root
    for (const el of document.querySelectorAll('main, main *, [role="main"], [role="main"] *')) {
      const oy = getComputedStyle(el).overflowY
      if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > best.scrollHeight) best = el
    }
    return best
  }

  // Scroll one screenful, then wait for X to append more rows. Polling beats a
  // fixed pause: fast when X answers quickly, patient when it is slow.
  async function scrollStep(el, budget = 2000) {
    const height = el.scrollHeight
    const top = el.scrollTop
    el.scrollBy({ top: el.clientHeight * 0.9 })
    const deadline = Date.now() + budget
    while (scrolling && Date.now() < deadline) {
      await sleep(120)
      if (el.scrollHeight > height) return 'grew'
    }
    // No new rows and the page did not move: probably the end of the list.
    return el.scrollTop <= top && el.scrollHeight === height ? 'end' : 'idle'
  }

  async function autoScroll(onDone) {
    if (scrolling) return
    scrolling = true
    let idle = 0
    let reachedEnd = false
    try {
      while (scrolling && idle < 6) {
        const el = scrollTarget()
        // Reaching the bottom is also what makes X load the next batch, so give
        // a suspected end one patient retry before stopping.
        let step = await scrollStep(el)
        if (step === 'end') step = await scrollStep(el, 4000)
        if (step === 'end') { reachedEnd = true; break }
        idle = step === 'grew' ? 0 : idle + 1
      }
      // Several screens with nothing new also means X has nothing more to show.
      if (idle >= 6) reachedEnd = true
    } finally {
      scrolling = false
      onDone?.(reachedEnd)
    }
  }

  // Shared with content/page-ui.js (same isolated world).
  globalThis.__xBlockerBridge = {
    browser,
    send,
    callMain,
    setScrolling(on, onDone) {
      if (on) autoScroll(onDone)
      else scrolling = false
    },
  }

  // Replies use sendResponse (Chrome ignores returned Promises).
  browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    const reply = handle(msg)
    if (!reply) return false
    reply.then(sendResponse, (e) => sendResponse({ __error: String(e?.message ?? e) }))
    return true
  })

  function handle(msg) {
    switch (msg?.type) {
      case 'tab:ping':
        return callMain('status', {}, 5_000).then(
          (s) => ({ ok: true, running, scrolling, ...s }),
          (e) => ({ ok: false, running, scrolling, error: errInfo(e) }),
        )
      case 'tab:run':
        runToken = msg.token
        wake?.()
        runLoop()
        return Promise.resolve({ ok: true })
      case 'tab:scroll':
        if (msg.on) autoScroll()
        else scrolling = false
        return Promise.resolve({ ok: true, scrolling: Boolean(msg.on) })
      default:
        return undefined
    }
  }
})()
