// SPDX-License-Identifier: GPL-3.0-or-later
// Cross-browser helpers for ES-module contexts (background, popup, dashboard).
// Firefox exposes promise-based `browser`; Chrome MV3 exposes promise-based
// `chrome` but does not accept a returned Promise from runtime.onMessage
// listeners, so replies go through sendResponse, which works in both.

export const browser = globalThis.browser ?? globalThis.chrome

// Registers a message handler that may return a value or a Promise.
// Return `undefined` to leave the message to other listeners.
export function onMessage(handler) {
  browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    let result
    try {
      result = handler(msg, sender)
    } catch (e) {
      sendResponse({ __error: String(e?.message ?? e) })
      return false
    }
    if (result === undefined) return false
    Promise.resolve(result).then(
      (value) => sendResponse(value),
      (e) => sendResponse({ __error: String(e?.message ?? e) }),
    )
    return true
  })
}

// runtime.sendMessage that turns a handler error back into a rejection.
export async function sendMessage(msg) {
  const res = await browser.runtime.sendMessage(msg)
  if (res && typeof res === 'object' && '__error' in res) throw new Error(res.__error)
  return res
}
