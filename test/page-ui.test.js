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
  <div class="icons"><div class="g"><button>G</button><span></span></div><div><button>…</button></div></div></div>
  <p>${text}</p><div><button>reply</button><button>like</button></div></article>`

async function load(body, { path = '/target/followers', search = '', respond = () => ({}), narrow = false, runs = 1, storage = {} } = {}) {
  const { window, document } = parseHTML(`<html><body>${body}</body></html>`)
  const location = { pathname: path, search }
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    const isButton = this.tagName === 'BUTTON'
    const width = isButton ? 90 : narrow && this.classList?.contains('cell') ? 300 : 0
    return { top: 0, left: 0, width, height: isButton ? 36 : 0 }
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
        if (m.type === 'page:config') return { inPageButtons: true, blockedScreenNames: [] }
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
    message: (m) => listeners.forEach((f) => f(m)),
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

test('post buttons join the header icon row before the first icon', async () => {
  const page = await load(`<main>${post('a')}</main>`, { path: '/home' })
  const btn = page.buttons()[0]
  assert.ok(btn.classList.contains('xb-action'))
  assert.equal(btn.parentElement.className, 'icons')
  assert.equal(btn.nextElementSibling.className, 'g')
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

test('panel shows live queue progress', async () => {
  const page = await load(`<main>${cell('alice')}</main>`)
  await page.click('.fab')
  const sub = () => page.shadow().querySelector('.sub').textContent
  const runner = (state, extra = {}) => ({ state, done: 4, failed: 0, skipped: 1, lastBeat: Date.now(), ...extra })
  page.message({ type: 'page:progress', runner: runner('running'), queueLen: 9 })
  await sleep(200)
  assert.equal(sub(), 'Blocking · 5 of 14 · 1 skipped')
  page.message({ type: 'page:progress', runner: runner('paused'), queueLen: 9 })
  await sleep(200)
  assert.equal(sub(), 'Blocking paused · 5 of 14 · 1 skipped')
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
  assert.equal(page.shadow().querySelector('.title').textContent, 'Block queue')
  assert.equal(page.shadow().querySelector('.panel .btn-danger').hidden, true)
})

test('a run of unblocks reports unblocking, not blocking', async () => {
  const page = await load(`<main>${cell('alice')}</main>`)
  await page.click('.fab')
  page.message({ type: 'page:progress', runner: { state: 'running', done: 0, unblocked: 2, failed: 0, skipped: 0, lastBeat: Date.now() }, queueLen: 3 })
  await sleep(200)
  assert.equal(page.shadow().querySelector('.sub').textContent, 'Unblocking · 2 of 5')
  page.message({ type: 'page:progress', runner: { state: 'idle', done: 0, unblocked: 5, failed: 0, skipped: 0, lastBeat: Date.now() }, queueLen: 0 })
  await sleep(200)
  assert.equal(page.shadow().querySelector('.sub').textContent, 'Done · 5 unblocked')
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
  assert.equal(page.shadow().querySelector('.run').hidden, true, 'one icon per line')
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
