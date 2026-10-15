// SPDX-License-Identifier: GPL-3.0-or-later
// Isolated-world content script: relays commands between the extension
// (background/popup/dashboard) and the MAIN-world script, and executes the
// block queue while this tab is the active runner.
(() => {
  'use strict'

  const TAG = '__x_blocker__'
  const pending = new Map()
  let seq = 0

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || ev.origin !== location.origin) return
    const msg = ev.data
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
  const send = (msg) => browser.runtime.sendMessage(msg)
  const errInfo = (e) => ({ code: e?.code ?? 'error', message: String(e?.message ?? e), retryAt: e?.retryAt })

  // ---- queue runner -------------------------------------------------------

  let running = false
  let runToken = null

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
          await sleep(Math.min(next.waitMs, 20_000))
          continue
        }
        const { res, blockRequested } = await processItem(next.item)
        if (res?.stop) break
        // Wait only after an actual block call; a handle lookup that ended in a
        // skip just gets a short breather so lookups aren't fired back to back.
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
    const root = document.scrollingElement ?? document.documentElement
    if (root.scrollHeight > root.clientHeight + 50) return root
    let best = root
    for (const el of document.querySelectorAll('main, main *, [role="main"], [role="main"] *')) {
      const oy = getComputedStyle(el).overflowY
      if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > best.scrollHeight) best = el
    }
    return best
  }

  async function autoScroll(onDone) {
    if (scrolling) return
    scrolling = true
    let idle = 0
    try {
      while (scrolling && idle < 8) {
        const el = scrollTarget()
        const before = el.scrollHeight
        el.scrollBy({ top: el.clientHeight * 0.9, behavior: 'smooth' })
        await sleep(1500 + Math.random() * 700)
        idle = el.scrollHeight > before ? 0 : idle + 1
      }
    } finally {
      scrolling = false
      onDone?.()
    }
  }

  // Shared with content/page-ui.js (same isolated world).
  globalThis.__xBlockerBridge = {
    callMain,
    setScrolling(on, onDone) {
      if (on) autoScroll(onDone)
      else scrolling = false
    },
  }

  browser.runtime.onMessage.addListener((msg) => {
    switch (msg?.type) {
      case 'tab:ping':
        return callMain('status', {}, 5_000).then(
          (s) => ({ ok: true, running, scrolling, ...s }),
          (e) => ({ ok: false, running, scrolling, error: errInfo(e) }),
        )
      case 'tab:run':
        runToken = msg.token
        runLoop()
        return Promise.resolve({ ok: true })
      case 'tab:scroll':
        if (msg.on) autoScroll()
        else scrolling = false
        return Promise.resolve({ ok: true, scrolling: Boolean(msg.on) })
      default:
        return undefined
    }
  })
})()
