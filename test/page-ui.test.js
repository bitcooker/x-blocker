// SPDX-License-Identifier: GPL-3.0-or-later
// DOM-level tests for content/page-ui.js, run against linkedom in a VM context
// with a stubbed extension API.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { parseHTML } from 'linkedom'

const TOKENS = await readFile(new URL('../extension/ui/tokens.js', import.meta.url), 'utf8')
const SOURCE = (await readFile(new URL('../extension/content/page-ui.js', import.meta.url), 'utf8'))
  // Test hooks: expose the page's list and open the shadow root for inspection.
  .replace('const pageHandles = new Map()', 'const pageHandles = (globalThis.__handles = new Map())')
  .replace("attachShadow({ mode: 'closed' })", "attachShadow({ mode: 'open' })")

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Markup helpers shaped like x-web: account rows have one Follow button,
// posts are <article>s with header icons and an action bar.
const cell = (sn, { name = sn, bio = '', followClass = '' } = {}) => `
  <div class="cell" data-sn="${sn}"><div><a href="/${sn}"><span>${name}</span><div><span class="h">@${sn}</span></div></a>
  <div>${bio}</div></div><div class="w"><button class="${followClass}"><div><span>Follow</span></div></button></div></div>`
const mention = (sn) => `<a href="/${sn}"><span>@${sn}</span></a>`
const post = (sn, text = '') => `
  <article data-sn="${sn}"><div><a href="/${sn}"><span>Name</span></a><div><a href="/${sn}"><span class="h">@${sn}</span></a><span>·</span><span>1h</span></div>
  <div class="icons"><div class="g"><button>G</button><span></span></div><div class="m"><button>…</button></div></div></div>
  <p>${text}</p><div><button>reply</button><button>like</button></div></article>`

async function load(body, { path = '/target/followers', search = '', respond = () => ({}), narrow = false, runs = 1, storage = {}, config = {} } = {}) {
  const { window, document } = parseHTML(`<html><body>${body}</body></html>`)
  const location = { pathname: path, search }
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    const isButton = this.tagName === 'BUTTON' || this.getAttribute?.('role') === 'button'
    let top = 0, left = 0, width = 0, height = 0
    if (isButton) {
      height = 36
      // Header icons sit to the right of the author's @handle; the action bar is a
      // row below. In the opened-post ("Post") view the actions (Follow, Grok,
      // more) sit on a row below the name line. The name area holds a verified
      // badge: a text-sized role="button" that lands right of the @handle once the
      // display name is long.
      const row = this.closest?.('.icons, .actions')
      if (row) {
        left = 200 + [...row.querySelectorAll('button, [role="button"]')].indexOf(this) * 40
        width = 36
        top = row.classList?.contains('actions') ? 45 : 0
      } else if (this.closest?.('.name')) {
        left = 170
        width = 90
        height = 16
      } else {
        const peers = [...(this.parentElement?.querySelectorAll('button, [role="button"]') ?? [])]
        left = 40 + Math.max(0, peers.indexOf(this)) * 90
        width = 90
        top = 60
      }
    } else if (this.classList?.contains('h')) {
      left = 40
      width = 110
      height = 16
    } else if (narrow && this.classList?.contains('cell')) {
      width = 300
    }
    return { top, left, width, height, right: left + width, bottom: top + height }
  }
  const listeners = []
  const sent = []
  const changedListeners = []
  const store = { ...storage } // extension storage.local
  let observerCb = () => {}
  const browser = {
    runtime: {
      sendMessage: async (m) => {
        sent.push(m)
        if (m.type === 'page:config') return { blockButtons: 'everywhere', blockedScreenNames: [], ...config }
        if (m.type === 'page:viewer') return { screenName: 'me' }
        return respond(m)
      },
      onMessage: { addListener: (f) => listeners.push(f) },
    },
    storage: {
      local: {
        get: async (keys) => (typeof keys === 'string' ? { [keys]: store[keys] } : { ...store }),
        set: async (obj) => { Object.assign(store, obj) },
      },
      onChanged: { addListener: (f) => changedListeners.push(f) },
    },
  }
  const ctx = {
    window, document, console, URL, setTimeout, clearTimeout,
    DOMParser: window.DOMParser, Node: window.Node, CustomEvent: window.CustomEvent,
    NodeFilter: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_SKIP: 3 },
    location,
    getComputedStyle: (el) => ({
      position: 'static', display: 'block', flexDirection: 'column', minHeight: '36px',
      fontSize: '15px', fontFamily: 'TwitterChirp', fontWeight: '700', paddingLeft: '16px',
      backgroundColor: el.classList?.contains('x-blocked') ? 'rgb(244, 33, 46)' : 'rgb(0, 0, 0)',
    }),
    MutationObserver: class { constructor(cb) { observerCb = cb } observe() {} disconnect() {} },
    requestAnimationFrame: (f) => f(),
    __xBlockerBridge: {
      browser,
      send: (m) => browser.runtime.sendMessage(m),
      callMain: async (cmd) => (cmd === 'status' ? { viewerId: '1' } : {}),
      scroll: null,
      setScrolling(on, onDone) { ctx.__xBlockerBridge.scroll = { on, onDone } },
    },
  }
  vm.createContext(ctx)
  vm.runInContext(TOKENS, ctx)
  for (let i = 0; i < runs; i++) {
    vm.runInContext(SOURCE, ctx)
    await sleep(50)
  }
  await sleep(250)
  const buttons = () => [...document.querySelectorAll('.xb-pill, .xb-icon')]
  return {
    document,
    sent,
    buttons,
    visible: () => buttons().filter((b) => !b.hidden).map((b) => b.dataset.sn),
    handles: () => [...ctx.__handles.values()],
    shadow: () => document.getElementById('xb-root')?.shadowRoot,
    message: (m) => listeners.forEach((f) => f(m, {}, () => {})),
    ask: (m) => { let reply; listeners.forEach((f) => f(m, {}, (r) => { reply ??= r })); return reply },
    store,
    storageChanged: (changes, area = 'local') => changedListeners.forEach((f) => f(changes, area)),
    location,
    scroll: () => ctx.__xBlockerBridge.scroll,
    click: async (selector) => { document.getElementById('xb-root').shadowRoot.querySelector(selector).click(); await sleep(250) },
    mutate: async (records) => { observerCb(records); await sleep(50) },
  }
}

test('followers page lists only the main-column rows of that list', async () => {
  const page = await load(`<main>
    <header><span>@target</span></header>
    ${cell('target')}${cell('alice', { bio: `Fan of ${mention('famous')} and more words here` })}${cell('bob')}${cell('me')}
    <aside>${cell('BBCWorld')}</aside></main>`)
  assert.deepEqual(page.handles(), ['alice', 'bob'])
  // One button per row: no extra button for the @mention in alice's bio.
  assert.equal(page.buttons().filter((b) => b.closest('[data-sn="alice"]')).length, 1)
})

test('list members open in a modal: only the modal rows are listed', async () => {
  const page = await load(`<main>${cell('owner')}</main>
    <div role="dialog"><div>${cell('alice')}${cell('bob')}</div></div>`, { path: '/i/lists/123/members' })
  assert.deepEqual(page.handles(), ['alice', 'bob'])
})

test('a lone button inside a post never turns a mention into an account row', async () => {
  const page = await load(`<main><article data-sn="author"><div><a href="/author"><span>Name</span></a>
    <div><a href="/author"><span class="h">@author</span></a></div></div>
    <div><div><span>Block this:</span></div><div><a href="/spam"><span>@spam</span></a></div>
    <div><button>Show translation</button></div></div></article></main>`, { path: '/author/status/1' })
  assert.equal(page.buttons().filter((b) => b.dataset.sn === 'spam').length, 0)
  assert.equal(page.document.querySelectorAll('.xb-pill').length, 0)
})

test('replies page lists post authors, never mentions or the post owner', async () => {
  const page = await load(`<main>${post('target')}${post('r1', `hey ${mention('grok')} what is this`)}${post('r2')}</main>`,
    { path: '/target/status/123' })
  assert.deepEqual(page.handles(), ['r1', 'r2'])
})

test('pages without a list show no mass-block panel', async () => {
  const page = await load(`<main>${post('a')}${cell('b')}</main>`, { path: '/home' })
  assert.deepEqual(page.handles(), [])
  assert.equal(page.shadow()?.querySelector('.panel'), undefined)
})

test('a display name that looks like a handle cannot redirect a block', async () => {
  const page = await load(`<main>${cell('spammer123', { name: '@yourfriend' })}${cell('alice')}</main>`)
  assert.deepEqual(page.handles(), ['spammer123', 'alice'])
  assert.deepEqual(page.visible(), ['spammer123', 'alice'])
})

test('buttons follow the account when X re-uses a row for someone else', async () => {
  const page = await load(`<main>${cell('alice')}</main>`)
  const handle = page.document.querySelector('.h')
  handle.firstChild.nodeValue = '@bob'
  page.document.querySelector('[data-sn="alice"] a').setAttribute('href', '/bob')
  await page.mutate([{ type: 'characterData', target: handle.firstChild, addedNodes: [] }])
  assert.deepEqual(page.visible(), ['bob'])
})

test('pill sits after Follow (never between X nodes) and survives a re-render', async () => {
  const page = await load(`<main>${cell('alice')}</main>`)
  const wrapper = page.document.querySelector('.w')
  assert.deepEqual([...wrapper.children].map((c) => c.className), ['', 'xb-pill xb-abs'])
  assert.match(wrapper.getAttribute('style'), /margin-inline-start:98px/)
  const pill = wrapper.querySelector('.xb-pill')
  assert.equal(pill.style.fontFamily, 'TwitterChirp')

  const rerendered = page.document.createElement('button')
  rerendered.textContent = 'Follow'
  wrapper.replaceChildren(rerendered)
  await page.mutate([{ type: 'childList', target: wrapper, addedNodes: [...wrapper.childNodes] }])
  assert.equal(wrapper.querySelectorAll('.xb-pill').length, 1)
})

test('narrow rows get a compact icon button', async () => {
  const page = await load(`<main>${cell('alice')}</main>`, { narrow: true })
  assert.ok(page.buttons()[0].classList.contains('xb-compact'))
})

test('a Block button queues the account instead of blocking it on the spot', async () => {
  const page = await load(`<main>${cell('alice')}</main>`, {
    respond: (m) => {
      if (m.type === 'page:quickBlock') return { added: m.items.length, skipped: 0, batch: 'quick-2026-10-18' }
      if (m.type === 'page:cancelBatch') return { cancelled: 1, done: 0 }
      return {}
    },
  })
  const btn = page.buttons()[0]
  btn.click()
  await sleep(50)
  const queued = page.sent.find((m) => m.type === 'page:quickBlock')
  assert.deepEqual(JSON.parse(JSON.stringify(queued.items)), [{ screenName: 'alice' }])
  // Nothing is blocked on the spot: the paced queue runner does it.
  assert.equal(page.sent.some((m) => m.type === 'page:blocked'), false)
  assert.ok(btn.classList.contains('xb-queued'))
  assert.equal(btn.textContent, 'Queued')
  assert.equal(btn.title, '@alice is waiting in the block queue')

  // Undo takes the day's batch back out of the queue and resets the button.
  const undo = page.shadow().querySelector('.toast-action')
  assert.equal(undo.textContent, 'Undo')
  undo.click()
  await sleep(100)
  assert.equal(page.sent.find((m) => m.type === 'page:cancelBatch')?.id, 'quick-2026-10-18')
  assert.equal(btn.classList.contains('xb-queued'), false)
  assert.equal(btn.textContent, 'Block')
})

test('a Block button says so when the account is already queued', async () => {
  const page = await load(`<main>${cell('alice')}</main>`, {
    respond: (m) => (m.type === 'page:quickBlock' ? { added: 0, skipped: 1 } : {}),
  })
  const btn = page.buttons()[0]
  btn.click()
  await sleep(50)
  assert.equal(btn.classList.contains('xb-queued'), false)
  assert.equal(btn.textContent, 'Block')
  assert.match(page.shadow().querySelector('.toasts').textContent, /already queued or blocked/)
})

test('a Block button stays queued even when the run cannot start yet', async () => {
  const page = await load(`<main>${cell('alice')}</main>`, {
    respond: (m) => (m.type === 'page:quickBlock' ? { added: 1, skipped: 0, batch: 'b1', error: 'no x.com tab' } : {}),
  })
  const btn = page.buttons()[0]
  btn.click()
  await sleep(50)
  // It is in the queue, which is what the button reports.
  assert.ok(btn.classList.contains('xb-queued'))
  assert.match(page.shadow().querySelector('.toasts').textContent, /added to the block queue/)
})

test('post buttons join the header icon row, just before the more menu', async () => {
  const page = await load(`<main>${post('a')}</main>`, { path: '/home' })
  const btn = page.buttons()[0]
  assert.ok(btn.classList.contains('xb-action'))
  // A sibling of the icon wrappers, so the row's even gap applies on both sides.
  assert.equal(btn.parentElement.className, 'icons')
  assert.equal(btn.nextElementSibling.className, 'm')
  assert.equal(btn.nextElementSibling.textContent, '…')
})

test('a post wrapped in a clickable role="link" still gets its header button', async () => {
  // X wraps the whole card in role="link"; that must not hide the post's buttons.
  const page = await load(`<main><div role="link" tabindex="0">${post('a')}</div></main>`, { path: '/home' })
  const btn = page.buttons()[0]
  assert.ok(btn.classList.contains('xb-action'))
  assert.equal(btn.nextElementSibling.textContent, '…')
})

test('a post whose handle wraps to a second line still gets its header button', async () => {
  // Long name/affiliation pushes @handle onto its own row; the button must stay
  // in the top-right icon row and not land next to the handle.
  const page = await load(`<main><div role="link">${`
  <article data-sn="a"><div><div><a href="/a"><span>Goldie Ghamari | گلسا قمری</span></a></div>
  <div><a href="/a"><span class="h">@a</span></a><span>·</span><span>1h</span></div>
  <div class="icons"><div class="g"><button>G</button></div><div class="m"><button>…</button></div></div></div>
  <p>text</p><div><button>reply</button><button>like</button></div></article>`}</div></main>`, { path: '/home' })
  const btn = page.buttons()[0]
  assert.ok(btn.classList.contains('xb-action'))
  assert.equal(btn.nextElementSibling.textContent, '…')
})

test('a verified badge in the name block is not mistaken for a header icon', async () => {
  // The badge is a role="button" left of the handle; the button must not go there.
  const page = await load(`<main><div role="link"><article data-sn="a"><div>
    <div class="name"><a href="/a"><span>Name</span></a><span role="button" aria-label="Verified account">✓</span></div>
    <div><a href="/a"><span class="h">@a</span></a><span>·</span><span>1h</span></div>
    <div class="icons"><div class="g"><button>G</button></div><div class="m"><button>…</button></div></div></div>
    <p>text</p><div><button>reply</button><button>like</button></div></article></div></main>`, { path: '/home' })
  const btn = page.buttons()[0]
  assert.ok(btn.classList.contains('xb-action'))
  assert.equal(btn.parentElement.className, 'icons')
  assert.equal(btn.nextElementSibling.className, 'm')
  assert.equal(btn.closest('.name'), null)
})

test('the verified tick steals no button in the opened-post view', async () => {
  // In the "Post" view the actions row renders below the name line. With a long
  // display name the verified tick (a text-sized role="button") is right of the
  // @handle and is then the top-most small button — it must not be taken for the
  // "more" menu, or the icon lands in the name block above the Follow button.
  const page = await load(`<main><article data-sn="a"><div>
    <div class="name"><a href="/a"><span>Louise 🧑‍🤝‍🧑 🏳️‍🌈</span></a><span role="button" aria-label="Verified account">✓</span></div>
    <div><a href="/a"><span class="h">@a</span></a></div>
    <div class="actions"><div><button>Follow</button></div><div><button>G</button></div><div class="m"><button>…</button></div></div></div>
    <p>text</p><div><button>reply</button><button>like</button></div></article></main>`, { path: '/home' })
  const btn = page.buttons()[0]
  assert.ok(btn.classList.contains('xb-action'))
  assert.equal(btn.parentElement.className, 'actions')
  assert.equal(btn.nextElementSibling.className, 'm')
  assert.equal(btn.nextElementSibling.textContent, '…')
  assert.equal(btn.closest('.name'), null)
})

test('a button anchored before the header settles moves in front of the more menu', async () => {
  // The opened post renders the Follow button first; the Grok and "more" icons
  // arrive a beat later. The button must not stay stranded before Follow.
  const page = await load(`<main><article data-sn="a"><div>
    <div><a href="/a"><span class="h">@a</span></a></div>
    <div class="actions"><div class="f"><button>Follow</button></div></div></div>
    <p>text</p></article></main>`, { path: '/home' })
  assert.equal(page.buttons()[0].nextElementSibling.textContent, 'Follow') // only Follow so far
  const actions = page.document.querySelector('.actions')
  const grok = page.document.createElement('div')
  grok.className = 'g'
  grok.innerHTML = '<button>G</button>'
  const more = page.document.createElement('div')
  more.className = 'm'
  more.innerHTML = '<button aria-haspopup="menu">…</button>'
  actions.append(grok)
  actions.append(more)
  await page.mutate([{ type: 'childList', target: actions, addedNodes: [grok, more] }])
  const btn = page.buttons()[0]
  assert.ok(btn.classList.contains('xb-action'))
  assert.equal(btn.parentElement.className, 'actions')
  assert.equal(btn.nextElementSibling.className, 'm')
  assert.equal(btn.nextElementSibling.textContent, '…')
})

test('a post whose header renders late gets its button once it appears', async () => {
  // X sometimes renders the post before its header icons. Nothing should be
  // dropped next to the handle; the button appears when the header does.
  const page = await load(`<main><div role="link"><article data-sn="a"><div>
    <a href="/a"><span>Name</span></a>
    <div><a href="/a"><span class="h">@a</span></a><span>·</span><span>1h</span></div></div>
    <p>text</p><div><button>reply</button><button>like</button></div></article></div></main>`, { path: '/home' })
  assert.equal(page.buttons().length, 0) // no header yet
  const header = page.document.querySelector('article > div')
  const icons = page.document.createElement('div')
  icons.className = 'icons'
  icons.innerHTML = '<div class="g"><button>G</button></div><div class="m"><button>…</button></div>'
  header.append(icons)
  await page.mutate([{ type: 'childList', target: header, addedNodes: [icons] }])
  const btn = page.buttons()[0]
  assert.ok(btn.classList.contains('xb-action'))
  assert.equal(btn.nextElementSibling.textContent, '…')
})

test('a quoted card (a nested article) gets no button of its own', async () => {
  const page = await load(`<main><article data-sn="outer"><div>
    <a href="/outer"><span>Outer</span></a>
    <div><a href="/outer"><span class="h">@outer</span></a><span>·</span><span>1h</span></div>
    <div class="icons"><div class="m"><button>…</button></div></div></div>
    <div role="link"><article data-sn="q"><div><a href="/q"><span>Quoted</span></a>
      <div><a href="/q"><span class="h">@q</span></a><span>·</span><span>1h</span></div></div>
      <p>quoted text</p></article></div></article></main>`, { path: '/home' })
  assert.deepEqual(page.buttons().map((b) => b.dataset.sn), ['outer'])
})

test('already-blocked accounts get no button and are left out of the review', async () => {
  const page = await load(`<main>${cell('alice')}${cell('bob', { followClass: 'x-blocked' })}${cell('carol')}</main>`, {
    respond: (m) => (m.type === 'page:lookup' ? { carol: { id: '3', blocking: true }, alice: { id: '1', blocking: false } } : {}),
  })
  await sleep(1700) // block-state lookup is debounced
  assert.deepEqual(page.visible(), ['alice'])
  // Still counted as loaded, but only alice can be reviewed.
  await page.click('.fab')
  assert.equal(page.shadow().querySelector('.sub').textContent, '3 loaded so farLoad all')
  assert.equal(page.shadow().querySelector('.panel .btn-danger').textContent, 'Review 1')
})

test('the panel stays when every loaded account is already blocked', async () => {
  const page = await load(`<main>${cell('bob', { followClass: 'x-blocked' })}${cell('carol', { followClass: 'x-blocked' })}</main>`)
  await sleep(300)
  await page.click('.fab')
  assert.ok(page.shadow().querySelector('.panel'))
  assert.equal(page.shadow().querySelector('.sub').textContent, 'All 2 loaded accounts are already blockedLoad all')
  assert.equal(page.shadow().querySelector('.panel .btn-danger').hidden, true)
  await page.click('.sub .btn-xs')
  page.scroll().onDone(true)
  await sleep(200)
  assert.equal(page.shadow().querySelector('.sub').textContent, '✓All 2 accounts in this list are already blocked')
})

test('re-injection leaves a single UI instance', async () => {
  const page = await load(`<main>${cell('alice')}</main>`, { runs: 3 })
  assert.equal(page.document.querySelectorAll('#xb-root').length, 1)
  assert.equal(page.buttons().length, 1)
  assert.equal(page.document.querySelectorAll('style[data-xb-style]').length, 1)
})

test('panel shows live queue progress in its own strip, below the list', async () => {
  const page = await load(`<main>${cell('alice')}</main>`)
  await page.click('.fab')
  const sub = () => page.shadow().querySelector('.run-text').textContent
  const strip = () => page.shadow().querySelector('.strip')
  assert.equal(strip().hidden, true)
  const runner = (state, extra = {}) => ({ state, done: 4, failed: 0, skipped: 1, lastBeat: Date.now(), ...extra })
  page.message({ type: 'page:progress', runner: runner('running'), queueLen: 9, etaMs: 25 * 60_000,
    current: { source: 'Followers of @x', action: 'block' } })
  await sleep(200)
  assert.equal(strip().hidden, false)
  assert.equal(sub(), 'Blocking · 5 of 14 · ~25 min left · 1 skipped · Followers of @x')
  assert.equal(page.shadow().querySelector('.strip .run').textContent, 'Pause')
  assert.equal(page.shadow().querySelector('.sub').textContent, '1 loaded so farLoad all', 'the list line stays about the list')
  page.message({ type: 'page:progress', runner: runner('paused'), queueLen: 9 })
  await sleep(200)
  assert.equal(sub(), 'Blocking paused · 5 of 14 · 1 skipped')
  assert.equal(page.shadow().querySelector('.strip .run').textContent, 'Resume')
  page.message({ type: 'page:progress', runner: runner('idle', { done: 12, skipped: 2 }), queueLen: 0 })
  await sleep(200)
  assert.equal(sub(), 'Done · 12 blocked · 2 skipped')
})

test('panel starts minimized on list pages', async () => {
  const page = await load(`<main>${cell('alice')}</main>`)
  assert.ok(page.shadow().querySelector('.fab'))
  assert.equal(page.shadow().querySelector('.panel'), null)
  await page.click('.fab')
  assert.ok(page.shadow().querySelector('.panel'))
})

test('the panel counts this list and saves nothing until Review', async () => {
  const page = await load(`<main>${cell('target')}${cell('alice', { bio: `hi ${mention('friend')} there and more` })}${cell('bob')}
    <aside>${cell('sidebar_acct')}</aside></main>`)
  await page.click('.fab')
  await sleep(900)
  assert.equal(page.shadow().querySelector('.sub').textContent, '2 loaded so farLoad all')
  assert.equal(page.shadow().querySelector('.btn-collect'), null)
  assert.deepEqual(page.sent.filter((m) => m.type !== 'page:lookup' && m.type !== 'page:progress' &&
    m.type !== 'page:config' && m.type !== 'page:viewer').map((m) => m.type), [])
})

test('leaving the page keeps the panel open', async () => {
  const page = await load(`<main>${cell('alice')}</main>`)
  await page.click('.fab')
  page.location.pathname = '/friend/following'
  const row = page.document.createElement('div')
  row.innerHTML = cell('friend_of_friend')
  page.document.querySelector('main').append(row)
  await page.mutate([{ type: 'childList', target: row, addedNodes: [row] }])
  await sleep(400)
  assert.ok(page.shadow().querySelector('.panel'))
  assert.equal(page.shadow().querySelector('.fab'), null)
  assert.equal(page.shadow().querySelector('.title').textContent, 'Accounts @friend follows')
})

test('the panel remembers the minimized state, across pages and tabs', async () => {
  const page = await load(`<main>${cell('alice')}</main>`)
  const panel = () => page.shadow().querySelector('.panel')
  const fab = () => page.shadow().querySelector('.fab')
  // Nothing stored yet: minimized.
  assert.equal(panel(), null)
  // Maximizing is saved, persists over navigation and follows other tabs.
  await page.click('.fab')
  assert.equal(page.store.panelMinimized, false)
  assert.ok(panel())
  page.location.pathname = '/friend/following'
  await page.mutate([{ type: 'childList', target: page.document.querySelector('main'), addedNodes: [] }])
  await sleep(200)
  assert.ok(panel())
  page.storageChanged({ panelMinimized: { newValue: true } })
  await sleep(200)
  assert.equal(panel(), null)
  // Minimizing is saved too.
  await page.click('.fab')
  await page.click('.min')
  assert.equal(page.store.panelMinimized, true)
  assert.equal(panel(), null)

  // A later page opens with the stored choice.
  const reopened = await load(`<main>${cell('bob')}</main>`, { storage: { panelMinimized: false } })
  assert.ok(reopened.shadow().querySelector('.panel'))
  assert.equal(reopened.shadow().querySelector('.fab'), null)
})

const respondReview = (m) => {
  if (m.type === 'page:massBlock') return { added: m.items.length, skipped: 0 }
  if (m.type === 'page:quota') return { used: 0, cap: 450, allowed: true }
  return {}
}

test('review queues the ticked accounts; friends and queued accounts start unticked', async () => {
  const page = await load(`<main>${cell('a1')}${cell('a2')}${cell('a3')}</main>`, {
    respond: (m) => {
      if (m.type === 'page:lookup') return { a1: { id: '1' }, a2: { id: '2', queued: true }, a3: { id: '3', following: true } }
      if (m.type === 'page:unqueue') return { removed: m.items.map((i) => i.screenName) }
      return respondReview(m)
    },
  })
  await page.click('.fab')
  await page.click('.btn-danger')
  const dialog = page.shadow().querySelector('.review')
  const boxes = () => [...dialog.querySelectorAll('li input')].map((b) => b.checked)
  const block = dialog.querySelector('.rf .btn-danger')
  const unqueue = dialog.querySelector('.bar .unqueue')
  assert.deepEqual(boxes(), [true, false, false])
  assert.equal(block.textContent, 'Block 1')
  assert.equal(unqueue.hidden, false)
  assert.equal(unqueue.disabled, true)

  // Ticking a queued account only enables "Remove from queue"; it isn't blocked twice.
  const queuedBox = dialog.querySelectorAll('li input')[1]
  queuedBox.checked = true
  queuedBox.dispatchEvent(new page.document.defaultView.Event('change'))
  await sleep(20)
  assert.equal(block.textContent, 'Block 1')
  assert.equal(unqueue.textContent, 'Remove 1 from queue')
  unqueue.click()
  await sleep(250)
  const sent = page.sent.find((m) => m.type === 'page:unqueue')
  assert.deepEqual(JSON.parse(JSON.stringify(sent.items)), [{ id: '2', screenName: 'a2' }])
  assert.equal(unqueue.hidden, true)
  assert.deepEqual(boxes(), [true, false, false], 'taken out of the queue means not blocked')

  block.click()
  await sleep(50)
  const queued = page.sent.find((m) => m.type === 'page:massBlock')
  assert.deepEqual(JSON.parse(JSON.stringify(queued.items)), [{ screenName: 'a1', id: '1', source: 'Followers of @target' }])
})

test('on other pages the panel only shows while the queue runs', async () => {
  const page = await load(`<main>${post('someone')}</main>`, { path: '/home', respond: respondReview })
  assert.equal(page.shadow()?.querySelector('.fab'), undefined)
  page.message({ type: 'page:progress', runner: { state: 'running', done: 4, failed: 0, skipped: 1, lastBeat: Date.now() }, queueLen: 9 })
  await sleep(250)
  assert.equal(page.shadow().querySelector('.fab').textContent, 'Blocking 5/14')
  await page.click('.fab')
  assert.equal(page.shadow().querySelector('.title').textContent, 'Queue')
  assert.equal(page.shadow().querySelector('.panel .btn-danger').hidden, true)
})

test('a run of unblocks reports unblocking, not blocking', async () => {
  const page = await load(`<main>${cell('alice')}</main>`)
  await page.click('.fab')
  page.message({ type: 'page:progress', runner: { state: 'running', done: 0, unblocked: 2, failed: 0, skipped: 0, lastBeat: Date.now() }, queueLen: 3 })
  await sleep(200)
  assert.equal(page.shadow().querySelector('.run-text').textContent, 'Unblocking · 2 of 5')
  page.message({ type: 'page:progress', runner: { state: 'idle', done: 0, unblocked: 5, failed: 0, skipped: 0, lastBeat: Date.now() }, queueLen: 0 })
  await sleep(200)
  assert.equal(page.shadow().querySelector('.run-text').textContent, 'Done · 5 unblocked')
})

test('the review dialog links each handle to its profile without changing the tick', async () => {
  const page = await load(`<main>${cell('a1')}</main>`, { respond: respondReview })
  await page.click('.fab')
  await page.click('.btn-danger')
  const dialog = page.shadow().querySelector('.review')
  const link = dialog.querySelector('li a.hd')
  assert.equal(link.textContent, '@a1')
  assert.equal(link.href, 'https://x.com/a1')
  assert.equal(link.target, '_blank')
  assert.equal(dialog.querySelectorAll('li input')[0].checked, true)
  link.dispatchEvent(new page.document.defaultView.Event('click', { bubbles: true }))
  await sleep(20)
  assert.equal(dialog.querySelectorAll('li input')[0].checked, true)
})

test('select all works after unticking everyone', async () => {
  const page = await load(`<main>${cell('a1')}${cell('a2')}${cell('a3')}</main>`, { respond: respondReview })
  await page.click('.fab')
  await page.click('.btn-danger')
  const dialog = page.shadow().querySelector('.review')
  const all = dialog.querySelector('.bar input')
  const ticked = () => [...dialog.querySelectorAll('li input')].map((b) => b.checked)
  const toggle = async () => { all.checked = !all.checked; all.dispatchEvent(new page.document.defaultView.Event('change')); await sleep(20) }

  assert.deepEqual(ticked(), [true, true, true])
  await toggle() // untick all
  assert.deepEqual(ticked(), [false, false, false])
  await toggle() // select all again
  assert.deepEqual(ticked(), [true, true, true])
  assert.equal(dialog.querySelector('.rf .btn-danger').textContent, 'Block 3')
  await toggle()
  await toggle()
  assert.deepEqual(ticked(), [true, true, true])
})

test('the panel says how much of the list is loaded and can load the rest', async () => {
  const page = await load(`<main>${cell('alice')}${cell('bob')}</main>`, {
    respond: (m) => {
      if (m.type === 'page:lookup' && m.screenNames.includes('target')) return { target: { followers: 17376 } }
      return respondReview(m)
    },
  })
  await page.click('.fab')
  await sleep(300)
  const sub = () => page.shadow().querySelector('.sub').textContent
  assert.equal(sub(), '2 loaded of ~17.4KLoad all')
  assert.equal(page.shadow().querySelector('.sub .btn-xs').textContent, 'Load all')

  await page.click('.sub .btn-xs')
  assert.equal(page.scroll().on, true)
  assert.equal(sub(), 'Loading 2 of ~17.4KStop')
  assert.equal(page.shadow().querySelector('.sub .dot').hidden, false)

  // The review says it is only part of the list, and offers to load the rest.
  page.scroll().onDone(false)
  await page.click('.panel .btn-danger')
  const note = page.shadow().querySelector('.review .rh p').textContent
  assert.match(note, /You're reviewing the 2 loaded of ~17\.4K\. Load all$/)
  page.shadow().querySelector('.review .rh .link').click()
  await sleep(50)
  assert.equal(page.shadow().querySelector('.review'), null)
  assert.equal(page.scroll().on, true)

  // Scrolling reached the end of the list.
  page.scroll().onDone(true)
  await sleep(200)
  assert.equal(sub(), '✓All 2 loaded')
  assert.match(page.shadow().querySelector('.toasts').textContent, /All 2 accounts in this list loaded/)
})

test('accounts loaded by scrolling show up in the counts, even when minimized', async () => {
  const page = await load(`<main>${cell('alice')}</main>`, { respond: respondReview })
  const fab = () => page.shadow().querySelector('.fab')
  assert.equal(fab().textContent, 'X Blocker · 1 loaded')
  const row = page.document.createElement('div')
  row.innerHTML = cell('bob') + cell('carol')
  page.document.querySelector('main').append(row)
  await page.mutate([{ type: 'childList', target: row, addedNodes: [row] }])
  await sleep(250)
  assert.equal(fab().textContent, 'X Blocker · 3 loaded')
  assert.ok(fab().classList.contains('bump'))
  await page.click('.fab')
  assert.equal(page.shadow().querySelector('.panel .btn-danger').textContent, 'Review 3')
})

test('the toolbar popup can ask the page about its list and start Review or Load all there', async () => {
  const page = await load(`<main>${cell('alice')}${cell('bob', { followClass: 'x-blocked' })}</main>`, { respond: respondReview })
  await sleep(300)
  assert.deepEqual(JSON.parse(JSON.stringify(page.ask({ type: 'tab:page' }))),
    { list: true, label: 'Followers of @target', loaded: 2, total: null, ended: false, loading: false, reviewable: 1 })
  assert.equal(page.shadow().querySelector('.panel'), null)

  // Review from the toolbar opens the panel and its review on the page.
  page.ask({ type: 'tab:review' })
  await sleep(300)
  assert.ok(page.shadow().querySelector('.panel'))
  assert.ok(page.shadow().querySelector('.review'))
  page.shadow().querySelector('.review .rf .btn:not(.btn-danger)').click()
  await sleep(50)

  page.ask({ type: 'tab:loadAll' })
  await sleep(200)
  assert.equal(page.scroll().on, true)
  assert.equal(page.ask({ type: 'tab:page' }).loading, true)

  const home = await load(`<main>${post('someone')}</main>`, { path: '/home' })
  assert.deepEqual(JSON.parse(JSON.stringify(home.ask({ type: 'tab:page' }))), { list: false })
})

test('review filters hide people you know and verified accounts, and estimate the time', async () => {
  const page = await load(`<main>${cell('a1')}${cell('a2')}${cell('a3')}</main>`, {
    respond: (m) => {
      if (m.type === 'page:lookup') return { a1: { id: '1' }, a2: { id: '2', followedBy: true }, a3: { id: '3', verified: true } }
      if (m.type === 'page:quota') return { used: 0, cap: 1000, allowed: true, paceMs: 7500 }
      if (m.type === 'page:massBlock') return { added: m.items.length, skipped: 0, batch: 'b1' }
      if (m.type === 'page:cancelBatch') return { cancelled: 2, done: 0 }
      return {}
    },
  })
  await page.click('.fab')
  await page.click('.panel .btn-danger')
  const dialog = page.shadow().querySelector('.review')
  const names = () => [...dialog.querySelectorAll('li .hd')].map((e) => e.textContent)
  const [known, verified] = dialog.querySelectorAll('.filters .filter')
  assert.deepEqual(names(), ['@a1', '@a2', '@a3'])
  assert.equal(dialog.querySelector('.rf .eta').textContent, 'under a minute at the current pace')

  known.click()
  await sleep(20)
  assert.deepEqual(names(), ['@a1', '@a3'])
  verified.click()
  await sleep(20)
  assert.deepEqual(names(), ['@a1'])
  assert.match(dialog.querySelector('.bar').textContent, /2 hidden/)
  verified.click()
  await sleep(20)

  // Hidden accounts are never blocked; Undo right after takes the batch back out of the queue.
  dialog.querySelector('.rf .btn-danger').click()
  await sleep(250)
  const block = page.sent.find((m) => m.type === 'page:massBlock')
  assert.deepEqual([...block.items.map((i) => i.screenName)], ['a1', 'a3'])
  const undo = page.shadow().querySelector('.toast-action')
  assert.equal(undo.textContent, 'Undo')
  undo.click()
  await sleep(100)
  assert.deepEqual(page.sent.find((m) => m.type === 'page:cancelBatch')?.id, 'b1')
  assert.match(page.shadow().querySelector('.toasts').textContent, /2 accounts taken out of the queue/)
})

test('Block buttons can be limited to list pages', async () => {
  const home = await load(`<main>${post('a')}</main>`, { path: '/home', config: { blockButtons: 'lists' } })
  assert.equal(home.buttons().length, 0)
  const list = await load(`<main>${cell('alice')}</main>`, { config: { blockButtons: 'lists' } })
  assert.equal(list.buttons().length, 1)
  const everywhere = await load(`<main>${post('a')}</main>`, { path: '/home' })
  assert.equal(everywhere.buttons().length, 1)
})

test('with Block buttons off, lists can still be loaded and reviewed', async () => {
  const page = await load(`<main>${cell('alice')}${cell('bob')}</main>`, { config: { blockButtons: 'off' } })
  assert.equal(page.buttons().length, 0)
  await page.click('.fab')
  assert.equal(page.shadow().querySelector('.panel .btn-danger').textContent, 'Review 2')
})
