// SPDX-License-Identifier: GPL-3.0-or-later
import { browser, sendMessage } from './compat.js'

// Minimal DOM helpers for extension pages. Never uses innerHTML so untrusted
// profile data (names, bios) cannot inject markup.

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue
    if (k === 'class') el.className = v
    else if (k === 'dataset') Object.assign(el.dataset, v)
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v)
    else if (k in el && typeof v !== 'string') el[k] = v
    else el.setAttribute(k, v === true ? '' : v)
  }
  for (const c of children.flat()) {
    if (c === undefined || c === null || c === false) continue
    el.append(c instanceof Node ? c : String(c))
  }
  return el
}

const SVG_NS = 'http://www.w3.org/2000/svg'

// Icons as path data (24×24), drawn in X's line style.
export const ICONS = {
  block: 'M12 3.75c-4.55 0-8.25 3.69-8.25 8.25 0 1.92.66 3.68 1.75 5.08L17.09 5.5C15.68 4.4 13.92 3.75 12 3.75zm6.5 3.17L6.92 18.5c1.4 1.1 3.16 1.75 5.08 1.75 4.56 0 8.25-3.69 8.25-8.25 0-1.92-.65-3.68-1.75-5.08zM1.75 12C1.75 6.34 6.34 1.75 12 1.75S22.25 6.34 22.25 12 17.66 22.25 12 22.25 1.75 17.66 1.75 12z',
  people: 'M7.5 2.5c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4-1.79-4-4-4zm-2 4c0-1.1.9-2 2-2s2 .9 2 2-.9 2-2 2-2-.9-2-2zm11 1c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3zm-1 3c0-.55.45-1 1-1s1 .45 1 1-.45 1-1 1-1-.45-1-1zM2 19.5c0-3.04 2.46-5.5 5.5-5.5s5.5 2.46 5.5 5.5v1H11v-1c0-1.93-1.57-3.5-3.5-3.5S4 17.57 4 19.5v1H2v-1zm14.5-3.5c-.88 0-1.69.29-2.34.79l-1.22-1.59c.99-.76 2.22-1.2 3.56-1.2 3.04 0 5.5 2.46 5.5 5.5v1h-2v-1c0-1.93-1.57-3.5-3.5-3.5z',
  queue: 'M3 5.5h12v2H3v-2zm0 5.5h12v2H3v-2zm0 5.5h8v2H3v-2zm14-5V7h2v4.5H23.5v2H19V18h-2v-4.5h-4.5v-2H17z',
  import: 'M11 3h2v10.59l3.29-3.3 1.42 1.42L12 17.41l-5.71-5.7 1.42-1.42L11 13.59V3zM4 15h2v4h12v-4h2v6H4v-6z',
  shield: 'M12 1.69l8.25 3.3V11c0 5.11-3.48 9.43-8.25 10.95C7.23 20.43 3.75 16.11 3.75 11V4.99L12 1.69zm-6.25 4.66V11c0 3.97 2.6 7.35 6.25 8.85 3.65-1.5 6.25-4.88 6.25-8.85V6.35L12 3.85 5.75 6.35zm9.54 2.94l1.42 1.42-5.71 5.7-3.21-3.2 1.42-1.42 1.79 1.8 4.29-4.3z',
  activity: 'M8.75 21V3h2v18h-2zM18 21V8.5h2V21h-2zM4 21l.004-10h2L6 21H4zm9.248 0v-7h2v7h-2z',
  settings: 'M10.54 1.75h2.92l1.57 2.36c.11.17.32.25.53.21l2.53-.59 2.17 2.17-.58 2.54c-.05.2.04.41.21.53l2.36 1.57v2.92l-2.36 1.57c-.17.12-.26.33-.21.53l.58 2.54-2.17 2.17-2.53-.59c-.21-.04-.42.04-.53.21l-1.57 2.36h-2.92l-1.58-2.36c-.11-.17-.32-.25-.52-.21l-2.54.59-2.17-2.17.58-2.54c.05-.2-.03-.41-.21-.53l-2.35-1.57v-2.92L4.1 8.97c.18-.12.26-.33.21-.53L3.73 5.9 5.9 3.73l2.54.59c.2.04.41-.04.52-.21l1.58-2.36zm1.07 2l-.98 1.47C10.05 6.08 9 6.5 7.99 6.27l-1.46-.34-.6.6.33 1.46c.24 1.01-.18 2.07-1.05 2.64l-1.46.98v.78l1.46.98c.87.57 1.29 1.63 1.05 2.64l-.33 1.46.6.6 1.46-.34c1.01-.23 2.06.19 2.64 1.05l.98 1.47h.78l.97-1.47c.58-.86 1.63-1.28 2.65-1.05l1.45.34.61-.6-.34-1.46c-.23-1.01.18-2.07 1.05-2.64l1.47-.98v-.78l-1.47-.98c-.87-.57-1.28-1.63-1.05-2.64l.34-1.46-.61-.6-1.45.34c-1.02.23-2.07-.19-2.65-1.05l-.97-1.47h-.78zM12 10.5c-.83 0-1.5.67-1.5 1.5s.67 1.5 1.5 1.5c.82 0 1.5-.67 1.5-1.5s-.68-1.5-1.5-1.5zM8.5 12c0-1.93 1.56-3.5 3.5-3.5 1.93 0 3.5 1.57 3.5 3.5s-1.57 3.5-3.5 3.5c-1.94 0-3.5-1.57-3.5-3.5z',
  search: 'M10.25 3.75c-3.59 0-6.5 2.91-6.5 6.5s2.91 6.5 6.5 6.5c1.795 0 3.419-.726 4.596-1.904 1.178-1.177 1.904-2.801 1.904-4.596 0-3.59-2.91-6.5-6.5-6.5zm-8.5 6.5c0-4.694 3.806-8.5 8.5-8.5s8.5 3.806 8.5 8.5c0 1.986-.682 3.815-1.824 5.262l4.781 4.781-1.414 1.414-4.781-4.781c-1.447 1.142-3.276 1.824-5.262 1.824-4.694 0-8.5-3.806-8.5-8.5z',
  play: 'M7 4.5v15l12-7.5L7 4.5z',
  pause: 'M6 4.5h4v15H6v-15zm8 0h4v15h-4v-15z',
  download: 'M12 16.41l-5.71-5.7 1.42-1.42L11 12.59V3h2v9.59l3.29-3.3 1.42 1.42L12 16.41zM4 15h2v4h12v-4h2v6H4v-6z',
  trash: 'M16 6V4.5C16 3.12 14.88 2 13.5 2h-3C9.11 2 8 3.12 8 4.5V6H3v2h1.06l.81 11.21C4.98 20.78 6.28 22 7.86 22h8.27c1.58 0 2.88-1.22 3-2.79L19.93 8H21V6h-5zm-6-1.5c0-.28.22-.5.5-.5h3c.27 0 .5.22.5.5V6h-4V4.5zm7.13 14.57c-.04.52-.47.93-1 .93H7.86c-.53 0-.96-.41-1-.93L6.07 8h11.85l-.79 11.07z',
  close: 'M10.59 12L4.54 5.96l1.42-1.42L12 10.59l6.04-6.05 1.42 1.42L13.41 12l6.05 6.04-1.42 1.42L12 13.41l-6.04 6.05-1.42-1.42L10.59 12z',
  external: 'M18.36 5.64c-1.95-1.96-5.11-1.96-7.07 0L9.88 7.05 8.46 5.64l1.42-1.42c2.73-2.73 7.16-2.73 9.9 0 2.73 2.74 2.73 7.17 0 9.9l-1.42 1.42-1.41-1.42 1.41-1.41c1.96-1.96 1.96-5.12 0-7.07zm-2.12 3.53l-7.07 7.07-1.41-1.41 7.07-7.07 1.41 1.41zm-12.02.71l1.42-1.42 1.41 1.42-1.41 1.41c-1.96 1.96-1.96 5.12 0 7.07 1.95 1.96 5.11 1.96 7.07 0l1.41-1.41 1.42 1.41-1.42 1.42c-2.73 2.73-7.16 2.73-9.9 0-2.73-2.74-2.73-7.17 0-9.9z',
}

export function icon(name, cls = 'i') {
  const s = document.createElementNS(SVG_NS, 'svg')
  s.setAttribute('viewBox', '0 0 24 24')
  s.setAttribute('aria-hidden', 'true')
  s.setAttribute('class', cls)
  const p = document.createElementNS(SVG_NS, 'path')
  p.setAttribute('d', ICONS[name])
  s.append(p)
  return s
}

// Replaces <i data-icon="name"></i> placeholders in static HTML.
export function hydrateIcons(root = document) {
  for (const el of root.querySelectorAll('i[data-icon]')) el.replaceWith(icon(el.dataset.icon))
}

export const send = (type, data = {}) => sendMessage({ type, ...data })

export function stateLabel(runner) {
  return {
    idle: 'Idle',
    running: 'Blocking',
    paused: 'Paused',
    cooldown: 'Cooling down',
    error: 'Stopped',
  }[runner.state] ?? runner.state
}

export function download(filename, text, mime = 'text/csv') {
  const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }))
  const a = h('a', { href: url, download: filename })
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

// The background announces which state keys changed (no payload); pages then
// fetch only what they display.
export function onStateChange(fn, delay = 300) {
  let t = null
  let keys = new Set()
  browser.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== 'state:changed') return
    for (const k of msg.keys ?? []) keys.add(k)
    clearTimeout(t)
    t = setTimeout(() => {
      const changed = [...keys]
      keys = new Set()
      fn(changed)
    }, delay)
  })
}

export function toast(message, { error = false, timeout } = {}) {
  let box = document.querySelector('.toasts')
  if (!box) {
    box = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' })
    document.body.append(box)
  }
  const t = h('div', { class: error ? 'toast error' : 'toast' }, String(message?.message ?? message))
  box.append(t)
  setTimeout(() => t.remove(), timeout ?? (error ? 6000 : 3500))
}

export function confirmDialog({ title, body, confirmLabel = 'Confirm', danger = true }) {
  return new Promise((resolve) => {
    const ok = h('button', { class: `btn btn-lg btn-block ${danger ? 'btn-danger' : 'btn-primary'}`, value: 'ok' }, confirmLabel)
    const cancel = h('button', { class: 'btn btn-lg btn-block', value: 'cancel' }, 'Cancel')
    const form = h('form', { method: 'dialog' }, h('h2', {}, title), h('p', {}, body), h('div', { class: 'actions' }, ok, cancel))
    const dialog = h('dialog', { class: 'modal' }, form)
    dialog.addEventListener('close', () => {
      resolve(dialog.returnValue === 'ok')
      dialog.remove()
    })
    dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close('cancel') })
    document.body.append(dialog)
    dialog.showModal()
    ok.focus()
  })
}
