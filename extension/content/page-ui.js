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
  let collectAlways = false
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
      if (at(3) === 'members') return { mode: 'cells', label: `Members of list ${p[2]}` }
      if (at(3) === 'followers') return { mode: 'cells', label: `Followers of list ${p[2]}` }
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
      case 'verified_followers':
        return { mode: 'cells', exclude, label: `Followers of @${user}` }
      case 'followers_you_follow':
        return { mode: 'cells', exclude, label: `Followers of @${user} you know` }
      case 'following':
        return { mode: 'cells', exclude, label: `Accounts @${user} follows` }
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

  function collect(host, screenName) {
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
    .xb-pill:focus-visible{box-shadow:0 0 0 2px #1d9bf0}
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
    .xb-icon:focus-visible{box-shadow:0 0 0 2px #1d9bf0}
    .xb-icon.xb-done{color:#f4212e;cursor:default}
    .xb-icon[aria-busy=true]{opacity:.5;cursor:progress}
    .xb-icon.xb-action{margin:0;width:34px;height:34px}
    .xb-icon.xb-action svg{width:20px;height:20px}
  `
  style.dataset.xbStyle = ''
  document.documentElement.append(style)

  function isAccountHandle(textNode) {
    const el = textNode.parentElement
    if (!el || el.closest('#xb-root, nav, header, [contenteditable="true"], textarea, [role="dialog"]')) return false
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
  function placeInPostActions(article, btn) {
    const top = article.getBoundingClientRect().top
    const buttons = [...article.querySelectorAll('button, [role="button"]')].filter((b) =>
      !b.classList.contains('xb-icon') && !b.closest('a, [role="link"]') && b.closest('article') === article)
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
      ui.toast(`Daily safety limit reached (${quota.used}/${quota.cap} in 24 h). Blocking more risks a forced logout by X.`, true)
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
      if (pageHandles.delete(key)) ui.scheduleUpdate()
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
        if (pageHandles.delete(key)) ui.scheduleUpdate()
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
        collect(host, screenName)
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
    collect(host, screenName)
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.dataset.handle = key
    btn.dataset.sn = screenName
    if (follow) {
      btn.className = 'xb-pill'
      followButtons.set(btn, follow)
      placeBeside(follow, btn)
    } else if (owner && placeInPostActions(owner, btn)) {
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
    css.textContent = `
      :host{all:initial}
      [hidden]{display:none!important}
      *{box-sizing:border-box;margin:0}
      .wrap{--bg:#fff;--fg:#0f1419;--muted:#536471;--border:#eff3f4;--hover:rgba(15,20,25,.1);
        --shadow:0 4px 16px rgba(15,20,25,.12);--backdrop:rgba(0,0,0,.4);
        font:15px/20px TwitterChirp,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:var(--fg)}
      .wrap[data-theme=dim]{--bg:#15202b;--fg:#f7f9f9;--muted:#8b98a5;--border:#38444d;--hover:rgba(247,249,249,.1);
        --shadow:0 4px 16px rgba(0,0,0,.4);--backdrop:rgba(91,112,131,.4)}
      .wrap[data-theme=dark]{--bg:#000;--fg:#e7e9ea;--muted:#71767b;--border:#2f3336;--hover:rgba(231,233,234,.1);
        --shadow:0 4px 16px rgba(0,0,0,.6);--backdrop:rgba(91,112,131,.4)}
      button{all:unset;box-sizing:border-box;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;
        gap:6px;border-radius:9999px;font-weight:700;white-space:nowrap;transition:background-color .2s,opacity .2s}
      button:focus-visible{box-shadow:0 0 0 2px #1d9bf0}
      button[disabled]{opacity:.5;cursor:default}
      .btn{height:36px;padding:0 16px;font-size:14px}
      .btn-outline{border:1px solid var(--border);color:var(--fg)}
      .btn-outline:hover:not([disabled]){background:var(--hover)}
      .btn-danger{background:#f4212e;color:#fff}
      .btn-danger:hover:not([disabled]){background:#dc1e29}
      .btn-ghost{width:34px;height:34px;color:var(--muted)}
      .btn-ghost:hover{background:var(--hover);color:var(--fg)}
      svg{width:18px;height:18px;fill:currentColor;flex:none}

      .panel{position:fixed;left:50%;bottom:20px;transform:translateX(-50%);z-index:2147483646;display:flex;
        align-items:center;gap:12px;padding:12px 12px 12px 16px;border-radius:16px;background:var(--bg);
        border:1px solid var(--border);box-shadow:var(--shadow);animation:rise .2s ease-out}
      .panel .logo{width:32px;height:32px;border-radius:9999px;background:rgba(244,33,46,.12);color:#f4212e;
        display:flex;align-items:center;justify-content:center;flex:none}
      .panel .text{display:flex;flex-direction:column;min-width:0}
      .panel .title{font-weight:700;font-size:15px}
      .panel .sub{color:var(--muted);font-size:13px;line-height:16px}
      .panel .count{font-variant-numeric:tabular-nums}
      .panel{overflow:hidden}
      .btn-collect[aria-pressed=true]{border-color:#1d9bf0;color:#1d9bf0;background:rgba(29,155,240,.1)}
      .btn-collect[aria-pressed=true]::before{content:"";width:8px;height:8px;border-radius:50%;background:#1d9bf0;
        animation:pulse 1.6s infinite}
      .fab .dot{width:8px;height:8px;border-radius:50%;background:#1d9bf0;animation:pulse 1.6s infinite}
      @keyframes pulse{50%{opacity:.35}}
      .panel .prog{position:absolute;left:0;right:0;bottom:0;height:3px;background:var(--border)}
      .panel .prog span{display:block;height:100%;width:0;background:#1d9bf0;transition:width .4s ease}
      .panel .prog[data-state=cooldown] span{background:#ffad1f}
      .panel .prog[data-state=done] span{background:#00ba7c}
      .panel .sub .on{color:#1d9bf0;font-weight:700}
      .panel .sub .ok{color:#00ba7c;font-weight:700}
      .panel .sub .warn{color:#ffad1f;font-weight:700}
      .panel .sub .err{color:#f4212e;font-weight:700}
      .fab{position:fixed;left:50%;bottom:20px;transform:translateX(-50%);z-index:2147483646;height:40px;
        padding:0 14px 0 12px;gap:8px;background:var(--bg);color:var(--fg);font-size:14px;
        border:1px solid var(--border);box-shadow:var(--shadow);animation:rise .2s ease-out}
      .fab svg{color:#f4212e}
      .fab:hover{background:var(--bg);border-color:var(--muted)}
      .fab .badge{min-width:22px;height:22px;padding:0 7px;border-radius:9999px;background:#f4212e;color:#fff;
        font-size:12px;line-height:22px;text-align:center;font-variant-numeric:tabular-nums}
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
      .panel .eyebrow{color:#f4212e;font-size:11px;line-height:14px;font-weight:700;text-transform:uppercase;letter-spacing:.04em}

      .review{width:560px;max-width:calc(100vw - 32px);max-height:min(720px,calc(100vh - 64px));background:var(--bg);
        border-radius:16px;display:flex;flex-direction:column;animation:pop .15s ease-out;overflow:hidden}
      .review .rh{padding:20px 24px 12px;display:grid;gap:4px;border-bottom:1px solid var(--border)}
      .review .rh h2{font-size:20px;line-height:24px;font-weight:800}
      .review .rh p{color:var(--muted);font-size:14px;line-height:18px}
      .review .src{display:inline-flex;align-items:center;gap:6px;width:fit-content;padding:4px 10px;border-radius:9999px;
        background:rgba(29,155,240,.12);color:#1d9bf0;font-weight:700;font-size:13px}
      .review .bar{display:flex;align-items:center;gap:12px;padding:10px 24px;border-bottom:1px solid var(--border);
        font-size:14px;color:var(--muted)}
      .review .bar label{display:flex;align-items:center;gap:8px;cursor:pointer;color:var(--fg);font-weight:700}
      .review ul{list-style:none;padding:0;margin:0;overflow:auto;flex:1}
      .review li{display:flex;align-items:center;gap:12px;padding:10px 24px;cursor:pointer;transition:background-color .15s}
      .review li:hover{background:var(--hover)}
      .review li.off{opacity:.55}
      .review img,.review .ph{width:40px;height:40px;border-radius:50%;flex:none;background:var(--border);object-fit:cover}
      .review .who{display:grid;min-width:0;flex:1}
      .review .nm{font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .review .hd{color:var(--muted)}
      .review .tags{display:flex;gap:4px;flex-wrap:wrap;justify-content:flex-end}
      .review .tag{font-size:12px;line-height:18px;padding:0 8px;border-radius:6px;background:var(--hover);color:var(--muted);font-weight:600}
      .review .tag.warn{background:rgba(0,186,124,.15);color:#00ba7c}
      .review input[type=checkbox]{width:18px;height:18px;margin:0;accent-color:#1d9bf0;cursor:pointer;flex:none}
      .review .limit{margin:0;padding:10px 24px;font-size:13px;line-height:18px;color:#ffad1f;
        background:rgba(255,173,31,.1);border-bottom:1px solid var(--border)}
      .review .rf{display:flex;gap:12px;justify-content:flex-end;padding:16px 24px;border-top:1px solid var(--border)}

      .toasts{position:fixed;left:50%;bottom:84px;transform:translateX(-50%);z-index:2147483647;display:flex;
        flex-direction:column;gap:8px;align-items:center;pointer-events:none}
      .toast{background:#1d9bf0;color:#fff;padding:12px 16px;border-radius:4px;font-size:15px;max-width:480px;
        box-shadow:var(--shadow);animation:rise .2s ease-out}
      .toast.error{background:#f4212e}
      @keyframes rise{from{opacity:0;transform:translate(-50%,8px)}}
      .toast{animation-name:fade}
      @keyframes fade{from{opacity:0}}
      @keyframes pop{from{opacity:0;transform:scale(.96)}}
      @keyframes spin{to{transform:rotate(360deg)}}
      @media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
      @media (max-width:700px){.panel{left:8px;right:8px;transform:none;bottom:72px;border-radius:16px}
        .panel .sub{display:none}@keyframes rise{from{opacity:0}}}
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
    const ICON_SCROLL = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 15.59l-4.29-4.3-1.42 1.42L12 18.41l5.71-5.7-1.42-1.42L12 15.59zm0-6l-4.29-4.3-1.42 1.42L12 12.41l5.71-5.7-1.42-1.42L12 9.59z"/></svg>'
    const ICON_STOP = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M7 7h10v10H7z"/></svg>'
    const ICON_MIN = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M5 11h14v2H5z"/></svg>'

    // Panel
    const panel = el('div', 'panel')
    panel.setAttribute('role', 'region')
    panel.setAttribute('aria-label', 'X Blocker')
    const count = el('span', 'count')
    const sub = el('span', 'sub', count)
    const title = el('span', 'title')
    const text = el('div', 'text', el('span', 'eyebrow', 'X Blocker'), title, sub)
    const logo = el('div', 'logo', svg(BLOCK_ICON))
    const scrollBtn = el('button', 'btn btn-outline')
    const blockAllBtn = el('button', 'btn btn-danger')
    const runBtn = el('button', 'btn btn-outline')
    const collectBtn = el('button', 'btn btn-outline btn-collect')
    const minBtn = el('button', 'btn-ghost', svg(ICON_MIN))
    minBtn.title = 'Minimize'
    minBtn.setAttribute('aria-label', 'Minimize X Blocker panel')
    const progBar = el('span', '')
    const prog = el('div', 'prog', progBar)
    prog.setAttribute('role', 'progressbar')
    panel.append(logo, text, scrollBtn, collectBtn, runBtn, blockAllBtn, minBtn, prog)

    const fabBadge = el('span', 'badge')
    const fabDot = el('span', 'dot')
    const fabLabel = el('span', '', 'X Blocker')
    const fab = el('button', 'fab', svg(BLOCK_ICON), fabLabel, fabDot, fabBadge)
    fab.title = 'X Blocker'
    fab.setAttribute('aria-label', 'Open X Blocker panel')

    // Starts minimized on every list page; the user opens it when they want it.
    let minimized = true
    let scrolling = false

    // ---- collecting: opt-in, for this page's list only ----------------------
    // Nothing is saved to the Collected list unless the user switches Collect on;
    // it switches off by itself when they leave the page.
    let collecting = false
    const collectedHere = new Set()
    let collectTimer = null

    function scheduleCollect() {
      if (!collecting) return
      clearTimeout(collectTimer)
      collectTimer = setTimeout(syncCollect, 700)
    }

    async function syncCollect() {
      if (!collecting || !context) return
      const pending = candidates().filter((sn) => !collectedHere.has(sn.toLowerCase()))
      if (!pending.length) return
      const source = context.label
      const r = await send({ type: 'page:collect', screenNames: pending, source }).catch(() => null)
      if (!collecting || context?.label !== source) return
      for (const sn of r?.saved ?? []) collectedHere.add(sn.toLowerCase())
      update()
      // IDs for some handles may arrive a moment later; try those again.
      if (r?.missing?.length) collectTimer = setTimeout(syncCollect, 2500)
    }

    function stopCollecting(notify) {
      if (!collecting) return
      collecting = false
      clearTimeout(collectTimer)
      if (notify && collectedHere.size) {
        toast(`Collecting stopped · ${collectedHere.size} account${collectedHere.size === 1 ? '' : 's'} saved`)
      }
    }

    collectBtn.addEventListener('click', () => {
      if (collecting) {
        stopCollecting(true)
      } else {
        collecting = true
        collectedHere.clear()
        toast(`Collecting "${context?.label}". Stops when you leave this page.`)
        syncCollect()
      }
      update()
    })

    // Live state of the block queue, mirrored from extension storage.
    let run = { runner: null, queueLen: 0 }
    const RECENT = 10 * 60 * 1000

    function runInfo() {
      const r = run.runner
      if (!r) return null
      const processed = (r.done ?? 0) + (r.failed ?? 0) + (r.skipped ?? 0)
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
      switch (r.state) {
        case 'running':
          return [el('span', '', `Blocking · ${of}`), tail]
        case 'cooldown': {
          const at = new Date(r.cooldownUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          return [el('span', 'warn', 'Waiting for X rate limit'), ` · resumes ${at} · ${of}`]
        }
        case 'paused':
          return [el('span', 'warn', 'Paused'), ` · ${of}${tail}`]
        case 'error':
          return [el('span', 'err', 'Stopped'), ` · ${r.message || 'error'}`]
        default:
          return [el('span', 'ok', 'Done'), ` · ${nf(r.done)} blocked${tail}`]
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
      runBtn.textContent = info.active ? 'Pause' : 'Resume'
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
      if (info) count.replaceChildren(...progressLine(info))
      else if (collecting) {
        count.replaceChildren(el('span', 'on', `Collecting · ${collectedHere.size} saved`), ' · scroll for more')
      } else {
        // Counting the list on screen is not collecting: say so explicitly.
        count.textContent = `${n} account${n === 1 ? '' : 's'} in this list · not saved`
      }
      scrollBtn.hidden = !context
      collectBtn.hidden = !context || collectAlways
      collectBtn.setAttribute('aria-pressed', String(collecting))
      collectBtn.textContent = collecting ? 'Collecting' : 'Collect'
      collectBtn.title = collecting
        ? 'Saving this list to the Collected list. Click to stop.'
        : 'Save the accounts of this list to the Collected list (until you leave this page)'
      fabDot.hidden = !collecting
      fabLabel.textContent = info?.active
        ? `Blocking ${info.processed}/${info.total}`
        : collecting ? `Collecting ${collectedHere.size}` : 'X Blocker'
      scrollBtn.replaceChildren(svg(scrolling ? ICON_STOP : ICON_SCROLL), scrolling ? 'Stop' : 'Scroll list')
      scrollBtn.title = scrolling ? 'Stop scrolling' : 'Scroll to the end of this list so every account is shown (nothing is saved)'
      blockAllBtn.textContent = n ? `Review ${n}` : 'Review'
      blockAllBtn.title = 'Review the accounts in this list before blocking them'
      blockAllBtn.disabled = n === 0
      fabBadge.textContent = n > 999 ? '999+' : String(n)
      fabBadge.hidden = true // a bare count on the pill reads like "collected"; the panel shows it
      scheduleCollect()
      // Also stay visible on other pages while the queue is running.
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

    minBtn.addEventListener('click', () => { minimized = true; update(); fab.focus() })
    fab.addEventListener('click', () => { minimized = false; update(); minBtn.focus() })
    scrollBtn.addEventListener('click', () => {
      scrolling = !scrolling
      update()
      setScrolling(scrolling, () => { scrolling = false; update() })
    })
    blockAllBtn.addEventListener('click', async () => {
      const list = candidates()
      if (!list.length || !context) return
      if (scrolling) { scrolling = false; setScrolling(false); update() }
      const source = context.label
      const picked = await reviewDialog(list, source)
      if (!picked?.length) return
      blockAllBtn.disabled = true
      try {
        const r = await send({
          type: 'page:massBlock',
          items: picked.map((u) => ({ screenName: u.screenName, id: u.id, source })),
        })
        if (r?.error) throw new Error(r.error)
        toast(`${r.added} account${r.added === 1 ? '' : 's'} from "${source}" queued for blocking`)
      } catch (e) {
        toast(String(e.message ?? e), true)
      }
      update()
    })

    // Lets the user confirm exactly which accounts of this list get blocked.
    // Accounts with a relationship to the viewer start unticked.
    async function reviewDialog(screenNames, source) {
      const [info, quota] = await Promise.all([
        send({ type: 'page:lookup', screenNames }).catch(() => null).then((v) => v ?? {}),
        send({ type: 'page:quota' }).catch(() => null),
      ])
      return new Promise((resolve) => {
        wrap.dataset.theme = document.documentElement.dataset.xbTheme ?? 'light'
        if (!host.isConnected) document.body.append(host)
        const previous = document.activeElement
        const rows = screenNames.map((sn) => {
          const u = info[sn.toLowerCase()] ?? {}
          const risky = Boolean(u.following || u.followedBy || u.blocking)
          return { screenName: sn, ...u, checked: !risky }
        })

        const confirm = el('button', 'btn btn-danger')
        const cancel = el('button', 'btn btn-outline', 'Cancel')
        const all = document.createElement('input')
        all.type = 'checkbox'
        const allLabel = el('label', '', all, el('span', '', 'Select all'))
        const summary = el('span', '')
        const limitNote = el('p', 'limit')
        const list = el('ul', '')
        list.setAttribute('aria-label', 'Accounts to block')

        const sync = () => {
          const n = rows.filter((r) => r.checked).length
          confirm.textContent = n ? `Block ${n}` : 'Block'
          confirm.disabled = n === 0
          all.checked = n === rows.length
          all.indeterminate = n > 0 && n < rows.length
          const skipped = rows.length - n
          summary.textContent = skipped ? `${skipped} unticked` : ''
          if (quota?.cap) {
            const left = Math.max(0, quota.cap - quota.used)
            limitNote.hidden = n <= left
            limitNote.textContent = `Safety limit: ${left} of ${quota.cap} blocks left in the last 24 h. ` +
              `The other ${Math.max(0, n - left)} will wait and continue automatically when the limit frees up.`
          } else limitNote.hidden = true
        }

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
          if (r.verified) tags.append(el('span', 'tag', 'Verified'))
          const li = el('li', r.checked ? '' : 'off', box, avatar,
            el('div', 'who', el('span', 'nm', r.name || `@${r.screenName}`), el('span', 'hd', `@${r.screenName}`)), tags)
          const set = (v) => { r.checked = v; box.checked = v; li.classList.toggle('off', !v); sync() }
          box.addEventListener('change', () => set(box.checked))
          li.addEventListener('click', (e) => { if (e.target !== box) set(!r.checked) })
          r.set = set
          list.append(li)
        }
        all.addEventListener('change', () => { for (const r of rows) r.set(all.checked) })

        const heading = el('h2', '', `Review ${rows.length} account${rows.length === 1 ? '' : 's'}`)
        heading.id = 'xb-review-title'
        const dialog = el('div', 'review',
          el('div', 'rh', el('span', 'src', source), heading,
            el('p', '', 'Only accounts from this list are included. Untick anyone you don\'t want to block. ' +
              'People you follow or who follow you start unticked.')),
          limitNote,
          el('div', 'bar', allLabel, summary),
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
        confirm.addEventListener('click', () => close(rows.filter((r) => r.checked)
          .map(({ screenName, id }) => ({ screenName, id }))))
        cancel.addEventListener('click', () => close(null))
        backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(null) })
        document.addEventListener('keydown', onKey, true)
        sync()
        wrap.append(backdrop)
        confirm.focus()
      })
    }

    function confirmDialog({ title, body, confirmLabel }) {
      return new Promise((resolve) => {
        wrap.dataset.theme = document.documentElement.dataset.xbTheme ?? 'light'
        if (!host.isConnected) document.body.append(host)
        const previous = document.activeElement
        const ok = el('button', 'btn btn-danger', confirmLabel)
        const cancel = el('button', 'btn btn-outline', 'Cancel')
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
      const t = el('div', error ? 'toast error' : 'toast', message)
      toasts.append(t)
      setTimeout(() => t.remove(), error ? 6000 : 3500)
    }

    return {
      update,
      scheduleUpdate,
      confirm: confirmDialog,
      toast,
      onNavigate() {
        stopCollecting(true)
        minimized = true
        scheduleUpdate()
      },
    }
  })()

  // ---- lifecycle -------------------------------------------------------------

  browser.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'page:blockedNotice' && msg.screenName) {
      blockedHere.add(msg.screenName.toLowerCase())
      markBlocked(msg.screenName)
      ui.scheduleUpdate()
    }
  })

  async function init() {
    const cfg = await send({ type: 'page:config' }).catch(() => null)
    enabled = cfg?.inPageButtons !== false
    collectAlways = cfg?.collectAlways === true
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
