// SPDX-License-Identifier: GPL-3.0-or-later
// In-page UI on x.com, styled after X's own components:
// - a "Block" pill next to each account's Follow button (user lists, Who to follow),
//   or a compact icon button next to the @handle elsewhere (posts);
// - a floating panel (bottom centre, collapsible) to mass-block the page;
// - X-style confirm dialog and toasts.
//
// x-web markup has no stable test ids, so accounts are found by their visible
// "@handle" text rather than by CSS class or data-testid.
(() => {
  'use strict'

  const { browser, send, callMain, setScrolling } = globalThis.__xBlockerBridge

  // Only one instance per page. When the extension is reloaded or updated, the browser may
  // inject a fresh copy while the old copy's UI is left behind; tell older copies
  // to tear down and remove anything they left in the DOM.
  const TAKEOVER = 'x-blocker:takeover'
  document.dispatchEvent(new CustomEvent(TAKEOVER))
  for (const el of document.querySelectorAll('#xb-root, style[data-xb-style], .xb-pill, .xb-icon')) el.remove()
  for (const el of document.querySelectorAll('[data-x-blocker], [data-xb-kind]')) {
    delete el.dataset.xBlocker
    delete el.dataset.xbKind
  }
  let alive = true
  const HANDLE_RE = /^@([A-Za-z0-9_]{1,15})$/
  const MARK = 'xBlocker'

  let enabled = true
  let panelMinimized = true // last choice, shared by every x.com tab (storage.local)
  let viewerScreenName = null
  const pageKey = () => location.pathname + location.search
  let pageUrl = pageKey()
  let context = null
  const pageHandles = new Map() // lowercase -> original case: accounts matching this page's list
  const blockedHere = new Set()

  // ---- page context: which list is this page, and which accounts belong to it ---

  const NOT_USERS = new Set([
    'home', 'explore', 'notifications', 'messages', 'i', 'settings', 'search', 'compose', 'jobs',
    'premium', 'communities', 'lists', 'bookmarks', 'chat', 'grok', 'tos', 'privacy',
  ])

  // mode "cells": account rows (followers, likes…); "authors": post authors (replies, quotes);
  // "any": both (search). `exclude` is the profile/post owner, never part of their own list.
  function pageContext() {
    const p = location.pathname.split('/').filter(Boolean)
    const at = (i) => (p[i] ?? '').toLowerCase()
    if (at(0) === 'search') {
      const q = new URLSearchParams(location.search).get('q')
      return q ? { mode: 'any', label: `Search results for "${q}"` } : null
    }
    if (at(0) === 'i' && at(1) === 'lists' && p[2]) {
      // X opens these lists in a modal over the list page.
      if (at(3) === 'members') return { mode: 'cells', dialog: true, label: `Members of list ${p[2]}` }
      if (at(3) === 'followers') return { mode: 'cells', dialog: true, label: `Followers of list ${p[2]}` }
      return null
    }
    if (at(0) === 'i' && at(1) === 'communities' && p[2] && at(3) === 'members') {
      return { mode: 'cells', label: `Members of community ${p[2]}` }
    }
    if (p.length < 2 || NOT_USERS.has(at(0)) || !/^[A-Za-z0-9_]{1,15}$/.test(p[0])) return null
    const user = p[0]
    const exclude = user.toLowerCase()
    switch (at(1)) {
      case 'followers':
        return { mode: 'cells', exclude, total: 'followers', label: `Followers of @${user}` }
      case 'verified_followers':
        return { mode: 'cells', exclude, label: `Verified followers of @${user}` }
      case 'followers_you_follow':
        return { mode: 'cells', exclude, label: `Followers of @${user} you know` }
      case 'following':
        return { mode: 'cells', exclude, total: 'followingCount', label: `Accounts @${user} follows` }
      case 'status': {
        if (!/^\d+$/.test(p[2] ?? '')) return null
        const what = at(3)
        if (what === 'likes') return { mode: 'cells', exclude, label: `Accounts that liked @${user}'s post` }
        if (what === 'retweets' || what === 'reposts') return { mode: 'cells', exclude, label: `Accounts that reposted @${user}'s post` }
        if (what === 'quotes') return { mode: 'authors', exclude, label: `Accounts that quoted @${user}'s post` }
        if (!what) return { mode: 'authors', exclude, label: `Replies to @${user}'s post` }
        return null
      }
      default:
        return null
    }
  }

  // The list lives in the main column; sidebars ("Who to follow", trends) never count.
  function inPrimaryColumn(host) {
    // Modal lists: only the modal counts, not the page behind it (e.g. the list's owner).
    if (context?.dialog) return Boolean(host.closest('[role="dialog"]'))
    const main = host.closest('main, [role="main"]')
    if (!main || host.closest('aside, [role="complementary"]')) return false
    const m = main.getBoundingClientRect()
    const r = host.getBoundingClientRect()
    if (m.width === 0 || r.width === 0) return true
    // x-web's <main> may span the list and the right sidebar; keep the left part.
    return main.querySelector('aside, [role="complementary"]') || m.width < 700
      ? true
      : r.left < m.left + m.width * 0.62
  }

  function addToList(host, screenName) {
    if (!context) return
    const key = screenName.toLowerCase()
    if (key === context.exclude || key === viewerScreenName || pageHandles.has(key)) return
    const kind = host.dataset.xbKind
    if (kind === 'mention' || (context.mode !== 'any' && context.mode !== kind)) return
    if (!inPrimaryColumn(host)) return
    pageHandles.set(key, screenName)
    ui.scheduleUpdate()
  }

  const BLOCK_ICON =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.75c-4.55 0-8.25 3.69-8.25 8.25 0 1.92.66 3.68 1.75 5.08L17.09 5.5C15.68 4.4 13.92 3.75 12 3.75zm6.5 3.17L6.92 18.5c1.4 1.1 3.16 1.75 5.08 1.75 4.56 0 8.25-3.69 8.25-8.25 0-1.92-.65-3.68-1.75-5.08zM1.75 12C1.75 6.34 6.34 1.75 12 1.75S22.25 6.34 22.25 12 17.66 22.25 12 22.25 1.75 17.66 1.75 12z"/></svg>'

  function svg(markup) {
    return new DOMParser().parseFromString(markup, 'image/svg+xml').documentElement
  }

  // ---- theme ------------------------------------------------------------------
  // X has light, dim and dark themes; derive ours from the page background.

  function detectTheme() {
    const bg = getComputedStyle(document.body).backgroundColor
    const [r, g, b] = (bg.match(/\d+/g) ?? [255, 255, 255]).map(Number)
    const theme = r + g + b > 600 ? 'light' : r + g + b < 30 ? 'dark' : 'dim'
    if (document.documentElement.dataset.xbTheme !== theme) document.documentElement.dataset.xbTheme = theme
  }

  // ---- inline buttons (light DOM, uniquely prefixed classes) ------------------

  const style = document.createElement('style')
  style.textContent = `
    :root{--xb-fg:#0f1419;--xb-border:#cfd9de;--xb-muted:#536471}
    :root[data-xb-theme=dim]{--xb-fg:#f7f9f9;--xb-border:#536471;--xb-muted:#8b98a5}
    :root[data-xb-theme=dark]{--xb-fg:#eff3f4;--xb-border:#536471;--xb-muted:#71767b}
    .xb-pill{all:unset;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;flex:none;
      align-self:center;min-width:36px;height:32px;padding:0 16px;margin-inline-end:8px;border-radius:9999px;
      border:1px solid var(--xb-border);color:var(--xb-fg);cursor:pointer;
      font:700 15px/20px TwitterChirp,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
      transition:background-color .2s,border-color .2s,color .2s;white-space:nowrap}
    .xb-pill:hover{background:rgba(244,33,46,.1);border-color:rgb(253,201,206);color:#f4212e}
    :root[data-xb-theme=dark] .xb-pill:hover,:root[data-xb-theme=dim] .xb-pill:hover{border-color:#67070f}
    .xb-pill:focus-visible{box-shadow:0 0 0 2px var(--accent)}
    .xb-pill[hidden],.xb-icon[hidden]{display:none}
    .xb-pill.xb-abs{position:absolute;inset-inline-end:100%;top:50%;transform:translateY(-50%);margin:0 8px 0 0;
      margin-inline-end:8px;margin-inline-start:0;z-index:1}
    .xb-pill.xb-compact{padding:0!important;min-width:0}
    .xb-pill.xb-compact svg{width:18px;height:18px;fill:currentColor}
    .xb-pill.xb-done{background:#f4212e;border-color:#f4212e;color:#fff;cursor:default}
    .xb-pill[aria-busy=true]{opacity:.6;cursor:progress}
    .xb-icon{all:unset;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;flex:none;
      align-self:center;width:28px;height:28px;margin-inline-start:4px;border-radius:9999px;color:var(--xb-muted);
      cursor:pointer;transition:background-color .2s,color .2s}
    .xb-icon svg{width:17px;height:17px;fill:currentColor}
    .xb-icon:hover{background:rgba(244,33,46,.1);color:#f4212e}
    .xb-icon:focus-visible{box-shadow:0 0 0 2px var(--accent)}
    .xb-icon.xb-done{color:#f4212e;cursor:default}
    .xb-icon[aria-busy=true]{opacity:.5;cursor:progress}
    .xb-icon.xb-action{margin:0;width:34px;height:34px}
    .xb-icon.xb-action svg{width:20px;height:20px}
  `
  style.dataset.xbStyle = ''
  document.documentElement.append(style)

  function isAccountHandle(textNode) {
    const el = textNode.parentElement
    if (!el || el.closest('#xb-root, nav, header, [contenteditable="true"], textarea')) return false
    if (!context?.dialog && el.closest('[role="dialog"]')) return false
    const handle = textNode.nodeValue.trim()
    if (el.textContent.trim() !== handle) return false
    // A mention inside tweet text is a link (just "@name") embedded in a sentence.
    // A post header's handle link only sits next to short "· 8h"-style metadata.
    const link = el.closest('a')
    if (link && link.textContent.trim() === handle && link.parentElement) {
      const around = link.parentElement.textContent.trim().length - handle.length
      if (around > 24) return false
    }
    return true
  }

  // A user cell (followers list, Who to follow) has exactly one action button:
  // Follow / Following / Unblock. Posts have many buttons and an <article>.
  function findFollowButton(host) {
    // Inside a post the only lone button nearby is something like "Show translation".
    if (host.closest('article')) return null
    let el = host
    for (let i = 0; i < 8 && el.parentElement; i++) {
      el = el.parentElement
      if (el.matches('article, main, [role="main"], section, body')) return null
      const buttons = [...el.querySelectorAll('button, [role="button"]')]
        .filter((b) => !b.classList.contains('xb-pill') && !b.classList.contains('xb-icon') && !b.closest('a[href*="/status/"]'))
      if (buttons.length === 1 && buttons[0].textContent.trim().length > 0) return buttons[0]
      if (buttons.length > 1) return null
    }
    return null
  }

  // Put the pill directly to the left of X's Follow button. Follow sits in its
  // own small wrapper (often a column); we turn just that wrapper into a row so
  // the two buttons are siblings, then copy Follow's metrics so both match.
  function placeBeside(follow, btn) {
    const wrapper = follow.parentElement
    if (!wrapper) return
    // React reorders siblings it manages; a node appended at the end of the
    // container never sits between them, so X's re-renders can't scramble it.
    if (getComputedStyle(wrapper).position === 'static') wrapper.style.position = 'relative'
    btn.classList.add('xb-abs')
    wrapper.append(btn)

    const label = [...follow.querySelectorAll('*')].reverse().find((e) => e.textContent.trim()) ?? follow
    const ls = getComputedStyle(label)
    const fs = getComputedStyle(follow)
    const height = follow.getBoundingClientRect().height
    if (height >= 24 && height <= 48) btn.style.height = `${Math.round(height)}px`
    btn.style.minHeight = fs.minHeight
    btn.style.fontFamily = ls.fontFamily
    btn.style.fontSize = ls.fontSize
    btn.style.fontWeight = ls.fontWeight
    if (fs.paddingLeft !== '0px') btn.style.paddingInline = fs.paddingLeft

    // Narrow places (sidebar "Who to follow"): icon-only so names aren't truncated.
    const row = wrapper.parentElement?.getBoundingClientRect()
    if (row && row.width > 0 && row.width < 420) {
      btn.classList.add('xb-compact')
      if (height >= 24 && height <= 48) btn.style.width = `${Math.round(height)}px`
    }
    reserveSpace(btn)
  }

  // Make room to the left of Follow for the absolutely positioned pill, so it
  // never covers the name; release it when the pill is hidden.
  function reserveSpace(btn) {
    const wrapper = btn.parentElement
    if (!wrapper || !btn.classList.contains('xb-abs')) return
    if (btn.hidden) {
      wrapper.style.marginInlineStart = ''
      return
    }
    requestAnimationFrame(() => {
      const w = btn.getBoundingClientRect().width
      if (!btn.hidden && w > 0) wrapper.style.marginInlineStart = `${Math.round(w) + 8}px`
    })
  }

  // Posts: join X's own round icon buttons at the top right of the post
  // (Grok, "more" menu) instead of touching the name/@handle/time header.
  // Those are the first buttons of the post in DOM order, above the action bar.
  function placeInPostActions(article, btn, host) {
    const top = article.getBoundingClientRect().top
    let buttons = [...article.querySelectorAll('button, [role="button"]')].filter((b) =>
      !b.classList.contains('xb-icon') && !b.closest('a, [role="link"]') && b.closest('article') === article)
    // With real layout, the header icons are the small buttons level with the author's
    // name, the right-most being "more". Pick that row rather than the first button in
    // DOM order, which on an opened post can be something else.
    const h = host.getBoundingClientRect()
    const header = buttons.map((b) => [b, b.getBoundingClientRect()])
      .filter(([, r]) => r.height > 0 && r.height <= 48 && r.top >= top - 1 && r.bottom <= h.bottom + 24)
    if (header.length) {
      const more = header.reduce((a, b) => (b[1].right > a[1].right ? b : a))
      buttons = header.filter(([, r]) => Math.abs(r.top - more[1].top) < 12)
        .sort((a, b) => a[1].left - b[1].left).map(([b]) => b)
    }
    const first = buttons[0]
    if (!first) return false
    const r = first.getBoundingClientRect()
    if (r.height > 0 && (r.top - top > 80 || r.height > 48)) return false

    // The row is the closest element holding both top icons (Grok and "more");
    // insert as a sibling inside it, right before the Grok icon's branch.
    const second = buttons[1]
    const r2 = second?.getBoundingClientRect()
    const sameRow = second && (r.height === 0 || Math.abs(r2.top - r.top) < 12)
    let target = first
    if (sameRow) {
      let row = first.parentElement
      while (row && row !== article && !row.contains(second)) row = row.parentElement
      if (!row || row === article) return false
      while (target.parentElement !== row) target = target.parentElement
    } else {
      // Only one icon up there: make its own wrapper a row so ours sits beside it.
      const wrap = first.parentElement
      wrap.style.display = 'flex'
      wrap.style.flexDirection = 'row'
      wrap.style.alignItems = 'center'
    }
    target.before(btn)
    btn.classList.add('xb-action')
    if (r.height >= 24 && r.height <= 48) {
      btn.style.width = btn.style.height = `${Math.round(r.height)}px`
    }
    return true
  }

  function setButtonState(btn, state) {
    const pill = btn.classList.contains('xb-pill')
    // Blocked accounts need no Block button (X shows its own "Blocked" state).
    btn.hidden = state === 'blocked'
    reserveSpace(btn)
    btn.classList.toggle('xb-done', state === 'blocked')
    btn.setAttribute('aria-busy', String(state === 'busy'))
    btn.disabled = state !== 'idle'
    const label = state === 'blocked' ? 'Blocked' : 'Block'
    btn.title = state === 'blocked' ? `@${btn.dataset.sn} is blocked` : `Block @${btn.dataset.sn}`
    btn.setAttribute('aria-label', btn.title)
    if (pill && btn.classList.contains('xb-compact')) {
      if (!btn.firstElementChild) btn.append(svg(BLOCK_ICON))
    } else if (pill) btn.textContent = state === 'busy' ? 'Blocking…' : label
  }

  async function blockNow(screenName, btn) {
    const ok = await ui.confirm({
      title: `Block @${screenName}?`,
      body: 'They will be able to see your public posts, but will no longer be able to engage with them. ' +
        '@' + screenName + ' will also not be able to follow or message you, and you will not see notifications from them.',
      confirmLabel: 'Block',
    })
    if (!ok) return
    const quota = await send({ type: 'page:quota' }).catch(() => null)
    if (quota && !quota.allowed) {
      ui.toast(quota.limit === 'hourly'
        ? `Hourly safety limit reached (${quota.usedHour}/${quota.hourly} in the last hour). Try again a bit later.`
        : `Daily safety limit reached (${quota.used}/${quota.cap} in 24 h). Blocking more risks a forced logout by X.`, true)
      return
    }
    setButtonState(btn, 'busy')
    try {
      const known = await send({ type: 'page:lookup', screenNames: [screenName] })
      let id = known?.[screenName.toLowerCase()]?.id
      if (!id) {
        const r = await callMain('resolve', { screenName })
        if (String(r?.screenName).toLowerCase() !== screenName.toLowerCase()) throw new Error('Unexpected lookup result')
        id = r.id
      }
      if (!/^\d{1,20}$/.test(String(id))) throw new Error('Invalid account id')
      await callMain('block', { userId: id })
      await send({ type: 'page:blocked', user: { id, screenName } })
      blockedHere.add(screenName.toLowerCase())
      markBlocked(screenName)
      ui.toast(`@${screenName} has been blocked`)
      ui.update()
    } catch (e) {
      setButtonState(btn, 'idle')
      ui.toast(`Couldn't block @${screenName}: ${e.message ?? e}`, true)
    }
  }

  // ---- knowing who is already blocked ---------------------------------------

  const hostButtons = new WeakMap() // handle element -> our button
  const claimed = new WeakSet() // Follow buttons / posts that already have their account's button
  const followButtons = new WeakMap() // our pill -> X's Follow/Blocked button
  const unknownState = new Set() // handles whose block state hasn't been confirmed yet

  // X renders its own "Blocked" button in solid red (any UI language).
  function looksBlocked(follow) {
    if (!follow?.isConnected) return false
    const [r, g, b] = (getComputedStyle(follow).backgroundColor.match(/\d+/g) ?? []).map(Number)
    return r > 200 && g < 80 && b < 90
  }

  function checkXButtons() {
    for (const btn of document.querySelectorAll('.xb-pill:not([hidden])')) {
      if (!looksBlocked(followButtons.get(btn))) continue
      const key = btn.dataset.handle
      blockedHere.add(key)
      unknownState.delete(key)
      setButtonState(btn, 'blocked')
      // Stays in the list (it is loaded), but candidates() leaves blocked accounts out.
      ui.scheduleUpdate()
    }
  }

  // Ask the extension what X's API said about these accounts' relationship to you.
  let lookupTimer = null
  function scheduleLookup(delay = 800) {
    clearTimeout(lookupTimer)
    lookupTimer = setTimeout(lookupBlockState, delay)
  }

  async function lookupBlockState() {
    if (!unknownState.size) return
    const handles = [...unknownState]
    const info = await send({ type: 'page:lookup', screenNames: handles }).catch(() => null)
    if (!info) return
    for (const key of handles) {
      const u = info[key]
      if (!u) continue // not captured yet; retried on the next scan
      unknownState.delete(key)
      if (u.blocking) {
        blockedHere.add(key)
        markBlocked(key)
        ui.scheduleUpdate()
      }
    }
  }

  function markBlocked(screenName) {
    const key = screenName.toLowerCase()
    for (const b of document.querySelectorAll('.xb-pill, .xb-icon')) {
      if (b.dataset.handle === key) setButtonState(b, 'blocked')
    }
  }

  // Anti-spoofing: an "@handle" only counts if it belongs to a link to that
  // profile. A spam account whose *display name* is "@yourfriend" sits inside a
  // link to the spammer, so it can never make you block @yourfriend.
  function linksToHandle(host, screenName) {
    const want = `/${screenName.toLowerCase()}`
    const path = (a) => {
      try { return new URL(a.getAttribute('href'), 'https://x.com').pathname.replace(/\/+$/, '').toLowerCase() } catch { return '' }
    }
    const own = host.closest('a[href]')
    if (own) return path(own) === want
    let el = host
    for (let i = 0; i < 4 && el.parentElement; i++) {
      el = el.parentElement
      if ([...el.querySelectorAll('a[href]')].some((a) => path(a) === want)) return true
    }
    return false
  }

  const liveHosts = new Set() // handle elements that currently own one of our buttons
  const hostOwner = new WeakMap() // handle element -> Follow button / article it claimed

  // Remove our button from a host so it can be re-evaluated (X re-used the
  // element for another account, or re-rendered the row without our button).
  function undecorate(host) {
    const btn = hostButtons.get(host)
    if (btn) {
      const wrapper = btn.parentElement
      btn.remove()
      if (wrapper && btn.classList.contains('xb-abs')) wrapper.style.marginInlineStart = ''
    }
    const owner = hostOwner.get(host)
    if (owner) claimed.delete(owner)
    hostButtons.delete(host)
    hostOwner.delete(host)
    liveHosts.delete(host)
    delete host.dataset[MARK]
    delete host.dataset.xbKind
    delete host.dataset.xbHandle
  }

  function decorate(textNode) {
    const m = HANDLE_RE.exec(textNode.nodeValue.trim())
    if (!m) return
    const screenName = m[1]
    const key = screenName.toLowerCase()
    const host = textNode.parentElement
    if (!host) return
    if (host.dataset[MARK]) {
      const prev = hostButtons.get(host)
      const stale = host.dataset.xbHandle !== key || // element now shows another account
        (host.dataset.xbKind === 'cells' && prev && !prev.isConnected) // X rebuilt the row
      if (!stale) {
        addToList(host, screenName)
        return
      }
      undecorate(host)
    }
    if (!isAccountHandle(textNode) || !linksToHandle(host, screenName)) return
    host.dataset[MARK] = '1'
    host.dataset.xbHandle = key
    const follow = findFollowButton(host)
    // One handle per account row / post: the first one (the account's own @handle).
    // Later handles in the same row or post are @mentions in the bio or text.
    const owner = follow ?? host.closest('article')
    if (owner) {
      if (claimed.has(owner)) {
        host.dataset.xbKind = 'mention'
        return
      }
      claimed.add(owner)
      hostOwner.set(host, owner)
    }
    host.dataset.xbKind = follow ? 'cells' : 'authors'
    addToList(host, screenName)
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.dataset.handle = key
    btn.dataset.sn = screenName
    if (follow) {
      btn.className = 'xb-pill'
      followButtons.set(btn, follow)
      placeBeside(follow, btn)
    } else if (owner && placeInPostActions(owner, btn, host)) {
      btn.className = 'xb-icon xb-action'
      btn.append(svg(BLOCK_ICON))
    } else {
      btn.className = 'xb-icon'
      btn.append(svg(BLOCK_ICON))
      const link = host.closest('a')
      const anchor = link && link.textContent.trim() === `@${screenName}` ? link : host
      anchor.after(btn)
    }
    hostButtons.set(host, btn)
    liveHosts.add(host)
    setButtonState(btn, blockedHere.has(key) ? 'blocked' : 'idle')
    if (!blockedHere.has(key)) unknownState.add(key)
    btn.addEventListener('click', (e) => {
      // Rows are links; don't navigate to the profile.
      e.preventDefault()
      e.stopPropagation()
      // Re-verify at click time: the row must still show this account.
      if (host.dataset.xbHandle !== key || !host.isConnected) return
      if (!btn.disabled) blockNow(screenName, btn)
    }, true)
  }

  const textFilter = {
    acceptNode: (n) => (n.nodeValue.length <= 17 && n.nodeValue.includes('@')
      ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP),
  }

  function scan(root) {
    if (!enabled || !root) return
    if (root.nodeType === Node.TEXT_NODE) {
      if (textFilter.acceptNode(root) === NodeFilter.FILTER_ACCEPT) decorate(root)
      return
    }
    if (root.nodeType !== Node.ELEMENT_NODE && root !== document.body) return
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, textFilter)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) decorate(n)
  }

  // Re-check hosts we already decorated: dropped from the page, rebuilt by X,
  // or re-used for a different account while scrolling.
  function recheckLive() {
    for (const host of liveHosts) {
      if (!host.isConnected) {
        hostButtons.get(host)?.remove()
        liveHosts.delete(host)
        continue
      }
      const tn = [...host.childNodes].find((n) => n.nodeType === Node.TEXT_NODE && n.nodeValue.includes('@'))
      if (tn) decorate(tn)
      else undecorate(host)
    }
  }

  // Incremental: only nodes X added or changed are scanned, not the whole page.
  let pending = new Set()
  let fullScan = true
  let scanQueued = false

  function queueScan() {
    if (scanQueued) return
    scanQueued = true
    requestAnimationFrame(() => {
      scanQueued = false
      if (!alive) return
      detectTheme()
      if (fullScan) {
        fullScan = false
        pending.clear()
        scan(document.body)
      } else {
        const nodes = pending
        pending = new Set()
        for (const n of nodes) if (n.isConnected) scan(n)
      }
      recheckLive()
      checkXButtons()
      if (unknownState.size) scheduleLookup()
    })
  }

  const observer = new MutationObserver((records) => {
    if (!alive) return
    if (pageKey() !== pageUrl) {
      pageUrl = pageKey()
      context = pageContext()
      pageHandles.clear()
      fullScan = true
      ui.onNavigate()
    }
    if (!fullScan) {
      for (const r of records) {
        if (r.target.closest?.('#xb-root') || r.target.parentElement?.closest?.('#xb-root')) continue
        if (r.type === 'characterData') pending.add(r.target)
        else for (const n of r.addedNodes) {
          if (n.nodeType === Node.ELEMENT_NODE && (n.id === 'xb-root' || n.classList?.contains('xb-pill') || n.classList?.contains('xb-icon'))) continue
          pending.add(n)
        }
      }
      if (pending.size > 400) fullScan = true // big re-render: one full pass is cheaper
    }
    queueScan()
  })

  // ---- floating panel, dialog, toasts (isolated in a shadow root) --------------

  const ui = (() => {
    const host = document.createElement('div')
    host.id = 'xb-root'
    const root = host.attachShadow({ mode: 'closed' })
    const css = document.createElement('style')
    // Shared tokens and components (ui/tokens.js), themed like X, then the panel's own layout.
    const { tokens, components } = globalThis.XB_STYLE
    css.textContent = `
      :host{all:initial}
      [hidden]{display:none!important}
      *{box-sizing:border-box;margin:0}
      button{all:unset;box-sizing:border-box;cursor:pointer;display:inline-flex;align-items:center;justify-content:center}
      button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
      button[disabled]{opacity:.5;cursor:default}
      ${tokens('.wrap')}
      .wrap{font:15px/20px var(--font);color:var(--fg)}
      ${components}
      svg{width:18px;height:18px;fill:currentColor;flex:none}
      .round{position:relative;width:13px;height:13px;flex:none;border-radius:50%;border:1px solid currentColor;color:var(--muted)}
      .round::after{content:"";position:absolute;inset:-6px}
      .round:hover:not([disabled]){background:var(--hover);color:var(--fg)}
      .round svg{width:7px;height:7px}

      .panel{position:fixed;left:50%;bottom:20px;transform:translateX(-50%);z-index:2147483646;display:flex;
        align-items:center;gap:12px;padding:12px 16px 12px 13px;border-radius:16px;background:var(--bg);
        border:1px solid var(--border);box-shadow:var(--shadow);animation:rise .2s ease-out}
      .panel .text{display:flex;flex-direction:column;gap:3px;min-width:0;--icon-col:18px}
      .panel .title{font-weight:700;font-size:15px;padding-left:var(--icon-col)}
      .panel .sub{color:var(--muted);font-size:12px;line-height:16px}
      .panel .sub .run[hidden] + .state[hidden] + .count{padding-left:var(--icon-col)}
      .panel .sub .state{display:flex;align-items:center;justify-content:center;width:13px;height:13px;flex:none}
      .panel .sub .state.ok{color:var(--ok);font-size:12px;font-weight:700}
      .panel .count b{color:var(--fg);font-weight:700}
      .panel .count .btn-xs{margin-inline-start:8px;vertical-align:middle}
      .panel .count{font-variant-numeric:tabular-nums}
      .panel .sub{display:flex;align-items:center;gap:5px}
      .panel .run{color:var(--fg)}
      .panel .run[data-state=paused]{color:var(--warn)}
      .panel{overflow:hidden}
      .panel .prog{position:absolute;left:0;right:0;bottom:0;height:3px;background:var(--border)}
      .panel .prog span{display:block;height:100%;width:0;background:var(--accent);transition:width .4s ease}
      .panel .prog[data-state=cooldown] span{background:var(--warn)}
      .panel .prog[data-state=done] span{background:var(--ok)}
      .panel .prog[data-state=indeterminate] span{width:30%!important;animation:slide 1.4s ease-in-out infinite}
      @keyframes slide{from{transform:translateX(-100%)}to{transform:translateX(340%)}}
      .panel .sub .ok{color:var(--ok);font-weight:700}
      .panel .sub .on{color:var(--accent);font-weight:700}
      .fab.done::after{content:"✓";color:var(--ok);font-weight:700}
      .link{display:inline;color:var(--accent);font-weight:700;font-size:inherit;line-height:inherit;border-radius:4px}
      .link:hover{text-decoration:underline}
      .panel .sub .warn{color:var(--warn);font-weight:700}
      .panel .sub .err{color:var(--danger);font-weight:700}
      .fab{position:fixed;left:50%;bottom:20px;transform:translateX(-50%);z-index:2147483646;height:40px;
        padding:0 14px 0 12px;gap:8px;background:var(--bg);color:var(--fg);font-size:14px;
        border:1px solid var(--border);box-shadow:var(--shadow);animation:rise .2s ease-out}
      .fab svg{color:var(--danger)}
      .fab:hover{background:var(--bg);border-color:var(--muted)}
      .spin{animation:spin 1s linear infinite}

      .backdrop{position:fixed;inset:0;z-index:2147483647;background:var(--backdrop);display:flex;align-items:center;
        justify-content:center;animation:fade .15s}
      .dialog{width:320px;max-width:calc(100vw - 32px);background:var(--bg);border-radius:16px;padding:32px;
        display:flex;flex-direction:column;gap:8px;animation:pop .15s ease-out}
      .dialog h2{font-size:20px;line-height:24px;font-weight:800;overflow-wrap:anywhere}
      .dialog p{color:var(--muted);font-size:15px;line-height:20px;margin-bottom:16px}
      .dialog .btn{height:44px;width:100%;font-size:15px}
      .dialog .actions{display:flex;flex-direction:column;gap:12px}

      .panel .title{max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .panel .eyebrow{color:var(--danger);font-size:11px;line-height:14px;font-weight:700;text-transform:uppercase;letter-spacing:.04em}
      .panel .head{display:flex;align-items:center;gap:5px}

      .review{width:560px;max-width:calc(100vw - 32px);max-height:min(720px,calc(100vh - 64px));background:var(--bg);
        border-radius:16px;display:flex;flex-direction:column;animation:pop .15s ease-out;overflow:hidden}
      .review .rh{padding:20px 24px 12px;display:grid;gap:4px;border-bottom:1px solid var(--border)}
      .review .rh h2{font-size:20px;line-height:24px;font-weight:800}
      .review .rh p{color:var(--muted);font-size:14px;line-height:18px}
      .review .src{display:inline-flex;align-items:center;gap:6px;width:fit-content;padding:4px 10px;border-radius:9999px;
        background:var(--accent-soft);color:var(--accent);font-weight:700;font-size:13px}
      .review .bar{display:flex;align-items:center;gap:12px;padding:10px 24px;border-bottom:1px solid var(--border);
        font-size:14px;color:var(--muted)}
      .review .bar label{display:flex;align-items:center;gap:8px;cursor:pointer;color:var(--fg);font-weight:700}
      .review .bar .acts{margin-inline-start:auto;display:flex;gap:8px}
      .review ul{list-style:none;padding:0;margin:0;overflow:auto;flex:1}
      .review li{display:flex;align-items:center;gap:12px;padding:10px 24px;cursor:pointer;transition:background-color .15s}
      .review li:hover{background:var(--hover)}
      .review li.off{opacity:.55}
      .review img,.review .ph{width:40px;height:40px;border-radius:50%;flex:none;background:var(--border);object-fit:cover}
      .review .who{display:grid;min-width:0;flex:1}
      .review .nm{font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .review .hd{color:var(--muted)}
      .review a.hd{text-decoration:none;width:max-content;max-width:100%}
      .review a.hd:hover{color:var(--accent);text-decoration:underline}
      .review .tags{display:flex;gap:4px;flex-wrap:wrap;justify-content:flex-end}
      .review .tag{font-size:12px;line-height:18px;padding:0 8px;border-radius:6px;background:var(--hover);color:var(--muted);font-weight:600}
      .review .tag.warn{background:var(--ok-soft);color:var(--ok)}
      .review input[type=checkbox]{width:18px;height:18px;margin:0;accent-color:var(--accent);cursor:pointer;flex:none}
      .review .limit{margin:0;padding:10px 24px;font-size:13px;line-height:18px;color:var(--warn);
        background:var(--warn-soft);border-bottom:1px solid var(--border)}
      .review .tabs{display:flex;gap:4px;padding:4px;margin-bottom:8px;border-radius:9999px;background:var(--hover);width:fit-content}
      .review .tab{height:32px;padding:0 14px;font-size:14px;color:var(--muted)}
      .review .tab[aria-selected=true]{background:var(--bg);color:var(--fg);box-shadow:0 1px 3px rgba(0,0,0,.2)}
      .review .from{font-size:12px;color:var(--accent);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .review li.loading{justify-content:center;color:var(--muted);cursor:default}
      .review .rf{display:flex;gap:12px;justify-content:flex-end;padding:16px 24px;border-top:1px solid var(--border)}

      .toasts{position:fixed;left:50%;bottom:84px;transform:translateX(-50%);z-index:2147483647;display:flex;
        flex-direction:column;gap:8px;align-items:center;pointer-events:none}
      @keyframes rise{from{opacity:0;transform:translate(-50%,8px)}}
      @keyframes fade{from{opacity:0}}
      @keyframes pop{from{opacity:0;transform:scale(.96)}}
      .bump{animation:bump .5s ease-out}
      .panel .count.bump{animation:glow .8s ease-out}
      @keyframes bump{40%{transform:scale(1.06)}}
      .fab.bump{animation:bumpFab .5s ease-out}
      @keyframes bumpFab{40%{transform:translateX(-50%) scale(1.06)}}
      @keyframes glow{from{color:var(--accent)}}
      .fab,.panel .btn-danger{font-variant-numeric:tabular-nums}
      @keyframes spin{to{transform:rotate(360deg)}}
      @media (max-width:700px){.panel{left:8px;right:8px;transform:none;bottom:72px;border-radius:16px}
        .panel .sub .count{display:none}@keyframes rise{from{opacity:0}}}
    `
    const wrap = document.createElement('div')
    wrap.className = 'wrap'
    const toasts = document.createElement('div')
    toasts.className = 'toasts'
    toasts.setAttribute('role', 'status')
    toasts.setAttribute('aria-live', 'polite')
    wrap.append(toasts)
    root.append(css, wrap)

    const el = (tag, cls, ...kids) => {
      const e = document.createElement(tag)
      if (cls) e.className = cls
      e.append(...kids)
      return e
    }
    const ICON_PLAY = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>'
    const ICON_PAUSE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>'
    const ICON_MIN = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M5 10.5h14v3H5z"/></svg>'

    // Panel
    const panel = el('div', 'panel')
    panel.setAttribute('role', 'region')
    panel.setAttribute('aria-label', 'X Blocker')
    const count = el('span', 'count')
    const runBtn = el('button', 'round run')
    // One icon per line: the run's play/pause, or the list's loading dot / check.
    const stateIcon = el('span', 'state')
    const sub = el('span', 'sub', runBtn, stateIcon, count)
    const title = el('span', 'title')
    const minBtn = el('button', 'round min', svg(ICON_MIN))
    minBtn.title = 'Minimize'
    minBtn.setAttribute('aria-label', 'Minimize X Blocker panel')
    // Collapse sits next to the brand label, out of the action row, so it
    // takes no width whatever buttons the panel shows.
    const text = el('div', 'text', el('div', 'head', minBtn, el('span', 'eyebrow', 'X Blocker')), title, sub)
    const loadBtn = el('button', 'btn btn-xs')
    const blockAllBtn = el('button', 'btn btn-danger')
    const progBar = el('span', '')
    const prog = el('div', 'prog', progBar)
    prog.setAttribute('role', 'progressbar')
    panel.append(text, blockAllBtn, prog)

    const fabLabel = el('span', '', 'X Blocker')
    const fabDot = el('span', 'dot dot-accent live')
    const fab = el('button', 'fab', svg(BLOCK_ICON), fabLabel, fabDot)
    fab.title = 'X Blocker'
    fab.setAttribute('aria-label', 'Open X Blocker panel')

    // Starts minimized until the user says otherwise; the choice is remembered.
    let minimized = panelMinimized
    let scrolling = false

    // ---- how much of the list is loaded ------------------------------------
    // X loads long lists a screenful at a time. Say how many are loaded, the
    // list's size when X told us (followers/following), and when the end is reached.
    let listEnded = false
    let listTotal = null
    let totalAskedAt = 0
    const fmt = (k) => k.toLocaleString()
    // Totals read better short ("~17.4K"); loaded counts stay exact.
    const compact = (k) => (k >= 10_000
      ? new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(k) : fmt(k))
    let lastLoaded = 0

    // A short highlight on the counts when scrolling brings in more accounts.
    function bump() {
      for (const e of [fab, blockAllBtn, count]) {
        e.classList.remove('bump')
        void e.offsetWidth // restart the animation
        e.classList.add('bump')
      }
    }

    async function fetchTotal() {
      if (!context?.total || !context.exclude || listTotal != null || Date.now() - totalAskedAt < 5000) return
      totalAskedAt = Date.now()
      const key = context.total
      const owner = context.exclude
      const info = await send({ type: 'page:lookup', screenNames: [owner] }).catch(() => null)
      const total = info?.[owner]?.[key]
      if (context?.exclude === owner && context.total === key && typeof total === 'number') {
        listTotal = total
        scheduleUpdate()
      }
    }

    function listState() {
      const loaded = pageHandles.size
      const ended = listEnded || (listTotal != null && loaded >= listTotal)
      return { loaded, ended, ofTotal: listTotal != null ? ` of ~${compact(listTotal)}` : '' }
    }

    function startLoading() {
      if (scrolling) return
      scrolling = true
      update()
      setScrolling(true, (reachedEnd) => {
        scrolling = false
        if (reachedEnd) {
          listEnded = true
          const { loaded } = listState()
          toast(`All ${fmt(loaded)} account${loaded === 1 ? '' : 's'} in this list loaded. Press Review to choose who to block.`)
        }
        update()
      })
    }

    function stopLoading() {
      if (!scrolling) return
      scrolling = false
      setScrolling(false)
      update()
    }

    loadBtn.addEventListener('click', () => (scrolling ? stopLoading() : startLoading()))

    function listLine() {
      const { loaded, ended, ofTotal } = listState()
      const num = el('b', '', fmt(loaded))
      stateIcon.className = 'state'
      if (scrolling) {
        stateIcon.replaceChildren(el('span', 'dot dot-accent live'))
        loadBtn.textContent = 'Stop'
        loadBtn.title = 'Stop loading; what is loaded so far stays'
        return ['Loading ', num, ofTotal, loadBtn]
      }
      if (ended) {
        stateIcon.replaceChildren(el('span', 'ok', '✓'))
        stateIcon.className = 'state ok'
        if (!candidates().length) return ['All ', num, ' accounts in this list are already blocked']
        return ['All ', num, ' loaded']
      }
      stateIcon.replaceChildren()
      loadBtn.textContent = 'Load all'
      loadBtn.title = listTotal > 2000
        ? 'Large list: loading everything takes a while and many requests to X. Consider blocking in batches.'
        : 'Scroll this list to its end so every account is loaded'
      // Nothing left to review here yet: say why, and offer the way to the rest.
      if (!candidates().length) return ['All ', num, ' loaded accounts are already blocked', loadBtn]
      return [num, ` loaded${ofTotal || ' so far'}`, loadBtn]
    }

    // Live state of the block queue, mirrored from extension storage.
    let run = { runner: null, queueLen: 0 }
    const RECENT = 10 * 60 * 1000

    function runInfo() {
      const r = run.runner
      if (!r) return null
      const processed = (r.done ?? 0) + (r.unblocked ?? 0) + (r.failed ?? 0) + (r.skipped ?? 0)
      const total = processed + run.queueLen
      const active = r.state === 'running' || r.state === 'cooldown'
      const recentlyDone = r.state === 'idle' && processed > 0 && Date.now() - (r.lastBeat ?? 0) < RECENT
      if (!active && r.state !== 'paused' && r.state !== 'error' && !recentlyDone) return null
      return { r, processed, total, active }
    }

    function progressLine(info) {
      const { r, processed, total } = info
      const nf = (n) => n.toLocaleString()
      const of = `${nf(processed)} of ${nf(total)}`
      const extras = [r.skipped ? `${nf(r.skipped)} skipped` : '', r.failed ? `${nf(r.failed)} failed` : '']
        .filter(Boolean).join(' · ')
      const tail = extras ? ` · ${extras}` : ''
      // A run made only of unblocks (from the dashboard) shouldn't say "Blocking".
      const verb = r.unblocked && !r.done ? 'Unblocking' : 'Blocking'
      switch (r.state) {
        case 'running':
          return [el('span', '', `${verb} · ${of}`), tail]
        case 'cooldown': {
          const at = new Date(r.cooldownUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          const why = r.limit === 'daily' ? 'Daily safety limit reached'
            : r.limit === 'hourly' ? 'Hourly safety limit reached'
            : r.limit === 'lookup' ? 'Waiting for X lookup limit' : `${verb} waits for X rate limit`
          return [el('span', 'warn', why), ` · resumes ${at} · ${of}`]
        }
        case 'paused':
          return [el('span', 'warn', `${verb} paused`), ` · ${of}${tail}`]
        case 'error':
          return [el('span', 'err', 'Stopped'), ` · ${r.message || 'error'}`]
        default: {
          const done = [r.done || !r.unblocked ? `${nf(r.done)} blocked` : '', r.unblocked ? `${nf(r.unblocked)} unblocked` : '']
            .filter(Boolean).join(' · ')
          return [el('span', 'ok', 'Done'), ` · ${done}${tail}`]
        }
      }
    }

    function applyRunState() {
      const info = runInfo()
      prog.hidden = !info
      runBtn.hidden = !info || !(info.active || (info.r.state === 'paused' && run.queueLen > 0))
      if (!info) return null
      const pct = info.total ? Math.round((info.processed / info.total) * 100) : 0
      progBar.style.width = `${info.r.state === 'idle' ? 100 : pct}%`
      prog.dataset.state = info.r.state === 'idle' ? 'done' : info.r.state
      prog.setAttribute('aria-valuenow', String(pct))
      runBtn.replaceChildren(svg(info.active ? ICON_PAUSE : ICON_PLAY))
      runBtn.dataset.state = info.active ? 'running' : 'paused'
      runBtn.title = info.active
        ? 'Pause after the current account'
        : 'Resume the queue'
      runBtn.setAttribute('aria-label', info.active ? 'Pause the queue' : 'Resume the queue')
      return info
    }

    // Progress is pushed by the background as small messages (never the whole store).
    const applyProgress = (p) => {
      if (!p || !alive) return
      run = { runner: p.runner ?? null, queueLen: p.queueLen ?? 0 }
      scheduleUpdate()
    }
    send({ type: 'page:progress' }).then(applyProgress, () => {})
    browser.runtime.onMessage.addListener((msg) => {
      if (msg?.type === 'page:progress') applyProgress(msg)
    })

    runBtn.addEventListener('click', async () => {
      const info = runInfo()
      if (!info) return
      runBtn.disabled = true
      try {
        const r = await send({ type: info.active ? 'page:pause' : 'page:resume' })
        if (r?.error) throw new Error(r.error)
      } catch (e) {
        toast(String(e.message ?? e), true)
      }
      runBtn.disabled = false
    })

    function candidates() {
      return [...pageHandles.entries()].filter(([k]) => !blockedHere.has(k)).map(([, v]) => v)
    }

    function update() {
      if (!alive) { host.remove(); return }
      wrap.dataset.theme = document.documentElement.dataset.xbTheme ?? 'light'
      const n = candidates().length
      const info = applyRunState()
      title.textContent = context?.label ?? 'Block queue'
      title.title = title.textContent
      // Loading wins over run progress: the user just asked for it and watches the count.
      const showRun = Boolean(info) && !scrolling
      if (showRun) count.replaceChildren(...progressLine(info))
      else if (context) count.replaceChildren(...listLine())
      else count.replaceChildren()
      if (!showRun) runBtn.hidden = true
      stateIcon.hidden = showRun || !stateIcon.firstChild
      // The bottom bar follows whatever the status line is about.
      if (scrolling) {
        const { loaded } = listState()
        prog.hidden = false
        prog.dataset.state = listTotal ? 'loading' : 'indeterminate'
        progBar.style.width = listTotal ? `${Math.min(100, Math.round((loaded / listTotal) * 100))}%` : ''
      }
      fetchTotal()
      // The loaded count is on the always-visible controls (pill, Review), not
      // only the status line, so scrolling visibly adds accounts in every state.
      const { loaded } = listState()
      fabLabel.textContent = info?.active ? `Blocking ${info.processed}/${info.total}`
        : context && loaded ? `X Blocker · ${fmt(loaded)} loaded`
          : 'X Blocker'
      blockAllBtn.textContent = n ? `Review ${fmt(n)}` : 'Review'
      fabDot.hidden = !scrolling
      fab.classList.toggle('done', Boolean(context && listState().ended && !info?.active))
      if (context && loaded > lastLoaded && lastLoaded > 0) bump()
      lastLoaded = context ? loaded : 0
      blockAllBtn.title = 'Review the accounts in this list before blocking them'
      // Nothing to review (e.g. the home timeline while the queue runs): hide it instead.
      blockAllBtn.hidden = n === 0
      // Also visible on other pages while the queue runs, to follow and pause it.
      const show = enabled && ((Boolean(context) && pageHandles.size > 0) || Boolean(info))
      if (show && !host.isConnected) document.body.append(host)
      panel.remove()
      fab.remove()
      if (show) wrap.append(minimized ? fab : panel)
    }

    let timer = null
    const scheduleUpdate = () => {
      clearTimeout(timer)
      timer = setTimeout(update, 150)
    }

    function saveMinimized(v) {
      minimized = panelMinimized = v
      const saved = browser.storage.local.set({ panelMinimized: v })
      saved?.catch?.(() => {})
      update()
    }

    minBtn.addEventListener('click', () => { saveMinimized(true); fab.focus() })
    fab.addEventListener('click', () => { saveMinimized(false); minBtn.focus() })
    async function listRows() {
      const list = candidates()
      const info = (await send({ type: 'page:lookup', screenNames: list }).catch(() => null)) ?? {}
      return list.map((sn) => ({ screenName: sn, ...info[sn.toLowerCase()], source: context.label }))
    }

    blockAllBtn.addEventListener('click', async () => {
      stopLoading()
      const n = context ? candidates().length : 0
      if (!n) return
      const { loaded, ended, ofTotal } = listState()
      const more = ended ? '' : listTotal != null
        ? `You're reviewing the ${fmt(loaded)} loaded${ofTotal}.`
        : `More accounts may load as you scroll.`
      const picked = await reviewDialog([{ label: 'This list', count: n, load: listRows, heading: context.label,
        note: 'Only accounts from this list are included.', more }])
      if (!picked?.length) return
      blockAllBtn.disabled = true
      try {
        const r = await send({
          type: 'page:massBlock',
          items: picked.map((u) => ({ screenName: u.screenName, id: u.id, source: u.source })),
        })
        if (r?.error) throw new Error(r.error)
        const queued = `${r.added} account${r.added === 1 ? '' : 's'} queued for blocking`
        toast(listState().ended ? queued : `${queued}. Press Load all or scroll, then Review again for the rest.`)
      } catch (e) {
        toast(String(e.message ?? e), true)
      }
      blockAllBtn.disabled = false
      update()
    })

    // Lets the user confirm exactly which accounts get blocked. Accounts with a
    // relationship to the viewer, or already queued, start unticked.
    async function reviewDialog(tabs) {
      const quota = await send({ type: 'page:quota' }).catch(() => null)
      return new Promise((resolve) => {
        wrap.dataset.theme = document.documentElement.dataset.xbTheme ?? 'light'
        if (!host.isConnected) document.body.append(host)
        const previous = document.activeElement
        let rows = []
        let active = 0
        let loadSeq = 0

        const confirm = el('button', 'btn btn-danger')
        const cancel = el('button', 'btn', 'Cancel')
        const all = document.createElement('input')
        all.type = 'checkbox'
        const allLabel = el('label', '', all, el('span', '', 'Select all'))
        const summary = el('span', '')
        const unqueueBtn = el('button', 'btn btn-sm unqueue')
        const limitNote = el('p', 'limit')
        const list = el('ul', '')
        list.setAttribute('aria-label', 'Accounts to block')
        const src = el('span', 'src')
        const heading = el('h2', '')
        heading.id = 'xb-review-title'
        const note = el('p', '')
        const tabBar = el('div', 'tabs')
        tabBar.setAttribute('role', 'tablist')
        const tabButtons = tabs.map((t, i) => {
          const b = el('button', 'tab', '')
          b.setAttribute('role', 'tab')
          b.addEventListener('click', () => select(i))
          return b
        })
        const labelTab = (i) => {
          const t = tabs[i]
          tabButtons[i].textContent = `${t.label} · ${t.loaded ? t.loaded.length : t.count}`
        }
        tabBar.append(...tabButtons)
        tabs.forEach((t, i) => labelTab(i))
        tabBar.hidden = tabs.length < 2

        const sync = () => {
          const ticked = rows.filter((r) => r.checked)
          const n = ticked.length
          // Queued accounts are already on their way: ticking them only serves
          // "Remove from queue", so they don't count toward "Block N".
          const nBlock = ticked.filter((r) => !r.queued).length
          const nQueued = n - nBlock
          confirm.textContent = nBlock ? `Block ${nBlock}` : 'Block'
          confirm.disabled = nBlock === 0
          all.checked = rows.length > 0 && n === rows.length
          all.indeterminate = n > 0 && n < rows.length
          const skipped = rows.length - n
          summary.textContent = skipped ? `${skipped} unticked` : ''
          unqueueBtn.hidden = !rows.some((r) => r.queued)
          unqueueBtn.textContent = `Remove ${nQueued} from queue`
          unqueueBtn.disabled = nQueued === 0
          unqueueBtn.title = 'Take the ticked accounts out of the block queue, so they won\'t be blocked'
          if (quota?.cap) {
            const left = Math.max(0, quota.cap - quota.used)
            limitNote.hidden = nBlock <= left
            limitNote.textContent = `Safety limit: ${left} of ${quota.cap} blocks left in the last 24 h. ` +
              `The other ${Math.max(0, nBlock - left)} will wait and continue automatically when the limit frees up.`
          } else limitNote.hidden = true
        }

        function renderRows() {
          list.replaceChildren()
          if (!rows.length) list.replaceChildren(el('li', 'loading', 'Nothing to review'))
          for (const r of rows) {
            const box = document.createElement('input')
            box.type = 'checkbox'
            box.checked = r.checked
            box.setAttribute('aria-label', `Block @${r.screenName}`)
            const avatar = r.avatar ? Object.assign(document.createElement('img'), { src: r.avatar, alt: '', loading: 'lazy' }) : el('div', 'ph')
            if (avatar.tagName === 'IMG') avatar.referrerPolicy = 'no-referrer'
            const tags = el('div', 'tags')
            if (r.following) tags.append(el('span', 'tag warn', 'You follow'))
            if (r.followedBy) tags.append(el('span', 'tag warn', 'Follows you'))
            if (r.blocking) tags.append(el('span', 'tag', 'Blocked'))
            if (r.queued) tags.append(el('span', 'tag', 'Queued'))
            if (r.verified) tags.append(el('span', 'tag', 'Verified'))
            const who = el('div', 'who', el('span', 'nm', r.name || `@${r.screenName}`))
            // Link the handle so you can open the profile while reviewing. It must
            // not toggle the row, which is what clicking anywhere else in it does.
            if (r.screenName) {
              const a = el('a', 'hd', `@${r.screenName}`)
              a.href = `https://x.com/${r.screenName}`
              a.target = '_blank'
              a.rel = 'noopener noreferrer'
              a.title = `Open @${r.screenName}'s profile in a new tab`
              who.append(a)
            }
            if (r.showSource) who.append(el('span', 'from', r.source))
            const li = el('li', r.checked ? '' : 'off', box, avatar, who, tags)
            const set = (v, quiet) => {
              r.checked = v
              box.checked = v
              li.classList.toggle('off', !v)
              if (!quiet) sync()
            }
            box.addEventListener('change', () => set(box.checked))
            li.addEventListener('click', (e) => { if (e.target !== box && !e.target.closest?.('a')) set(!r.checked) })
            r.set = set
            list.append(li)
          }
          sync()
        }

        async function select(i) {
          active = i
          const tab = tabs[i]
          tabButtons.forEach((b, j) => b.setAttribute('aria-selected', String(j === i)))
          src.textContent = tab.heading
          heading.textContent = `Review ${tab.count} account${tab.count === 1 ? '' : 's'}`
          note.textContent = `${tab.note} Untick anyone you don't want to block. People you follow or who follow you, and accounts already queued, start unticked.`
          if (tab.more) {
            const load = el('button', 'link', 'Load all')
            load.title = 'Close this and load the rest of the list'
            load.addEventListener('click', () => { close(null); startLoading() })
            note.append(el('span', 'more', ` ${tab.more} `), load)
          }
          // Selections are kept per tab while the dialog is open.
          tab.loaded ??= (await tab.load()).map((r) => ({
            ...r, checked: !(r.following || r.followedBy || r.blocking || r.queued),
          }))
          const seq = ++loadSeq
          rows = []
          list.replaceChildren(el('li', 'loading', 'Loading…'))
          sync()
          const loaded = await tab.loaded
          if (seq !== loadSeq) return
          rows = loaded
          labelTab(i)
          heading.textContent = `Review ${rows.length} account${rows.length === 1 ? '' : 's'}`
          renderRows()
        }

        // Read the choice once: sync() updates `all` itself, so reading it inside
        // the loop would flip every row after the first.
        all.addEventListener('change', () => {
          const value = all.checked
          for (const r of rows) r.set(value, true)
          sync()
        })

        unqueueBtn.addEventListener('click', async () => {
          const items = rows.filter((r) => r.checked && r.queued)
            .map((r) => ({ id: r.id, screenName: r.screenName }))
          if (!items.length) return
          unqueueBtn.disabled = true
          try {
            const res = await send({ type: 'page:unqueue', items })
            if (res?.error) throw new Error(res.error)
            const removed = res?.removed ?? []
            const gone = new Set(removed.map((s) => String(s).toLowerCase()))
            for (const t of tabs) {
              for (const r of t.loaded ?? []) {
                if (!gone.has((r.screenName ?? '').toLowerCase()) && !gone.has(String(r.id))) continue
                // Out of the queue means "don't block": untick so "Block N" doesn't re-add them.
                r.queued = false
                r.checked = false
              }
            }
            toast(removed.length
              ? `${removed.length} account${removed.length === 1 ? '' : 's'} removed from the queue`
              : 'Nothing removed: already out of the queue', !removed.length)
            renderRows()
          } catch (e) {
            toast(String(e.message ?? e), true)
          } finally {
            sync()
          }
        })

        const dialog = el('div', 'review',
          el('div', 'rh', tabBar, src, heading, note),
          limitNote,
          el('div', 'bar', allLabel, summary, el('div', 'acts', unqueueBtn)),
          list,
          el('div', 'rf', cancel, confirm))
        dialog.setAttribute('role', 'dialog')
        dialog.setAttribute('aria-modal', 'true')
        dialog.setAttribute('aria-labelledby', heading.id)
        const backdrop = el('div', 'backdrop', dialog)
        const close = (v) => {
          backdrop.remove()
          document.removeEventListener('keydown', onKey, true)
          previous?.focus?.()
          resolve(v)
        }
        const onKey = (e) => {
          if (e.key === 'Escape') { e.stopPropagation(); close(null) }
        }
        confirm.addEventListener('click', () => close(rows.filter((r) => r.checked && !r.queued)
          .map(({ screenName, id, source }) => ({ screenName, id, source }))))
        cancel.addEventListener('click', () => close(null))
        backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(null) })
        document.addEventListener('keydown', onKey, true)
        wrap.append(backdrop)
        select(0)
        confirm.focus()
      })
    }

    function confirmDialog({ title, body, confirmLabel }) {
      return new Promise((resolve) => {
        wrap.dataset.theme = document.documentElement.dataset.xbTheme ?? 'light'
        if (!host.isConnected) document.body.append(host)
        const previous = document.activeElement
        const ok = el('button', 'btn btn-danger', confirmLabel)
        const cancel = el('button', 'btn', 'Cancel')
        const heading = el('h2', '', title)
        heading.id = 'xb-dialog-title'
        const dialog = el('div', 'dialog', heading, el('p', '', body), el('div', 'actions', ok, cancel))
        dialog.setAttribute('role', 'alertdialog')
        dialog.setAttribute('aria-modal', 'true')
        dialog.setAttribute('aria-labelledby', heading.id)
        const backdrop = el('div', 'backdrop', dialog)
        const close = (v) => {
          backdrop.remove()
          document.removeEventListener('keydown', onKey, true)
          previous?.focus?.()
          resolve(v)
        }
        const onKey = (e) => {
          if (e.key === 'Escape') { e.stopPropagation(); close(false) }
          if (e.key === 'Tab') { e.preventDefault(); (root.activeElement === ok ? cancel : ok).focus() }
        }
        ok.addEventListener('click', () => close(true))
        cancel.addEventListener('click', () => close(false))
        backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(false) })
        document.addEventListener('keydown', onKey, true)
        wrap.append(backdrop)
        ok.focus()
      })
    }

    function toast(message, error = false) {
      wrap.dataset.theme = document.documentElement.dataset.xbTheme ?? 'light'
      if (!host.isConnected) document.body.append(host)
      const t = el('div', error ? 'toast toast-danger' : 'toast', message)
      toasts.append(t)
      setTimeout(() => t.remove(), error ? 6000 : 3500)
    }

    return {
      update,
      // What the toolbar popup shows about this tab.
      pageInfo() {
        if (!enabled || !context) return { list: false }
        const { loaded, ended } = listState()
        return { list: true, label: context.label, loaded, total: listTotal, ended, reviewable: candidates().length }
      },
      openPanel() {
        saveMinimized(false)
      },
      scheduleUpdate,
      confirm: confirmDialog,
      toast,
      // The user's minimized/maximized choice outlives navigation.
      setMinimized(v) {
        if (typeof v !== 'boolean' || v === minimized) return
        minimized = v
        scheduleUpdate()
      },
      onNavigate() {
        stopLoading()
        listEnded = false
        listTotal = null
        totalAskedAt = 0
        lastLoaded = 0
        scheduleUpdate()
      },
    }
  })()

  // ---- lifecycle -------------------------------------------------------------

  browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'tab:page') {
      sendResponse(ui.pageInfo())
      return false
    }
    if (msg?.type === 'tab:openPanel') {
      ui.openPanel()
      sendResponse({ ok: true })
      return false
    }
    if (msg?.type === 'page:blockedNotice' && msg.screenName) {
      blockedHere.add(msg.screenName.toLowerCase())
      markBlocked(msg.screenName)
      ui.scheduleUpdate()
    }
    if (msg?.type === 'page:unblockedNotice' && msg.screenName) {
      const key = msg.screenName.toLowerCase()
      blockedHere.delete(key)
      for (const b of document.querySelectorAll('.xb-pill, .xb-icon')) {
        if (b.dataset.handle === key) setButtonState(b, 'idle')
      }
      ui.scheduleUpdate()
    }
  })

  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && typeof changes.panelMinimized?.newValue === 'boolean') {
      panelMinimized = changes.panelMinimized.newValue
      ui.setMinimized(panelMinimized)
    }
  })

  async function init() {
    const stored = await browser.storage.local.get('panelMinimized').catch(() => null)
    if (typeof stored?.panelMinimized === 'boolean') {
      panelMinimized = stored.panelMinimized
      ui.setMinimized(panelMinimized)
    }
    const cfg = await send({ type: 'page:config' }).catch(() => null)
    enabled = cfg?.inPageButtons !== false
    for (const sn of cfg?.blockedScreenNames ?? []) blockedHere.add(sn)
    if (!enabled) return
    context = pageContext()
    callMain('status', {}, 10_000).then(async (st) => {
      if (!st.viewerId) return
      const r = await send({ type: 'page:viewer', id: st.viewerId })
      viewerScreenName = r?.screenName?.toLowerCase() ?? null
      if (viewerScreenName && pageHandles.delete(viewerScreenName)) ui.scheduleUpdate()
    }).catch(() => {})
    detectTheme()
    scan(document.body)
    checkXButtons()
    scheduleLookup(1500)
    observer.observe(document.body, { childList: true, subtree: true, characterData: true })
  }

  document.addEventListener(TAKEOVER, () => {
    alive = false
    observer.disconnect()
    ui.update()
    clearTimeout(lookupTimer)
  }, { once: true })

  init()
})()
