// SPDX-License-Identifier: GPL-3.0-or-later
// Toolbar popup: a remote control. The queue (what, how far, how long, pause),
// the safety limits, and what X Blocker can do on the current tab.
import { send, stateLabel, onStateChange, hydrateIcons, fmtNum, fmtDuration } from '../lib/dom.js'
import { browser } from '../lib/compat.js'

const $ = (id) => document.getElementById(id)
const HOSTS = { origins: ['https://x.com/*', 'https://api.x.com/*'] }
const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 })
let activeTab = null

function showError(e) {
  $('error').hidden = !e
  $('error-text').textContent = e ? String(e.message ?? e) : ''
}

const meter = (el, value, max) => { el.style.width = max ? `${Math.min(100, (value / max) * 100)}%` : '0' }

async function render() {
  const { runner, counts, settings, current } = await send('state:get')
  const active = runner.state === 'running' || runner.state === 'cooldown'
  $('status').textContent = stateLabel(runner)
  $('status').dataset.state = runner.state

  const processed = runner.done + (runner.unblocked ?? 0) + runner.failed + runner.skipped
  const total = processed + counts.queue
  $('now-title').textContent = counts.queue ? (current?.source ?? 'Working through the queue') : 'Nothing waiting'
  $('now-title').title = $('now-title').textContent
  const detail = []
  if (counts.queue) {
    detail.push(`${fmtNum(total - counts.queue)} of ${fmtNum(total)} done`)
    if (runner.state !== 'paused' && runner.state !== 'error') detail.push(`${fmtDuration(counts.etaMs)} left`)
  }
  if (runner.state === 'cooldown' || runner.state === 'error') detail.push(runner.message)
  $('now-detail').textContent = detail.filter(Boolean).join(' · ') || `${fmtNum(counts.blocked)} blocked in total`
  $('now-meter').hidden = !counts.queue
  meter($('now-bar'), total - counts.queue, total)

  $('start').hidden = active || !counts.queue
  $('pause').hidden = !active
  $('start').querySelector('span').textContent = runner.state === 'paused' ? 'Resume' : 'Start'

  const limit = (id, used, cap) => {
    $(id).textContent = cap ? `${fmtNum(used)} / ${fmtNum(cap)}` : fmtNum(used)
    meter($(`${id}-bar`), used, cap)
    $(`${id}-bar`).parentElement.className = `meter ${cap && used >= cap ? 'meter-warn' : ''}`
  }
  limit('lim-hour', counts.lastHour, settings.hourlyCap)
  limit('lim-day', counts.last24h, settings.dailyCap)
}

async function renderTab() {
  const onX = activeTab?.url?.startsWith('https://x.com/')
  $('open-x').hidden = onX
  if (!onX) {
    $('tab-list').hidden = true
    $('tab-hint').hidden = false
    $('tab-hint-text').textContent = 'Open a list on x.com, such as someone\'s followers or the replies to a post, to review and block it.'
    return
  }
  const info = await browser.tabs.sendMessage(activeTab.id, { type: 'tab:page' }).catch(() => null)
  if (!info) {
    $('tab-list').hidden = true
    $('tab-hint').hidden = false
    $('tab-hint-text').textContent = 'Reload this x.com tab so X Blocker can attach to it.'
    return
  }
  $('tab-list').hidden = !info.list
  $('tab-hint').hidden = info.list
  if (!info.list) {
    $('tab-hint-text').textContent = 'This page has no list to block. Open someone\'s followers or following, the likes, reposts or replies of a post, or a search.'
    return
  }
  $('tab-label').textContent = info.label
  $('tab-label').title = info.label
  const of = info.total ? ` of ~${compact.format(info.total)}` : ''
  $('tab-detail').textContent = info.ended
    ? `All ${fmtNum(info.loaded)} loaded · ${fmtNum(info.reviewable)} to review`
    : `${fmtNum(info.loaded)} loaded${of} · ${fmtNum(info.reviewable)} to review`
}

async function action(fn) {
  showError(null)
  try {
    await fn()
  } catch (e) {
    showError(e)
  }
  await render()
}

$('start').addEventListener('click', () => action(() =>
  send('runner:start', { tabId: activeTab?.url?.startsWith('https://x.com/') ? activeTab.id : undefined })))
$('pause').addEventListener('click', () => action(() => send('runner:pause')))
$('open-panel').addEventListener('click', async () => {
  await browser.tabs.sendMessage(activeTab.id, { type: 'tab:openPanel' }).catch(() => {})
  window.close()
})
$('open-x').addEventListener('click', () => {
  browser.tabs.create({ url: 'https://x.com/home' })
  window.close()
})
$('dashboard').addEventListener('click', () => {
  browser.runtime.openOptionsPage()
  window.close()
})
$('grant').addEventListener('click', async () => {
  if (await browser.permissions.request(HOSTS)) {
    $('perm').hidden = true
    if (activeTab?.url?.startsWith('https://x.com/')) browser.tabs.reload(activeTab.id)
  }
})

async function init() {
  hydrateIcons()
  $('version').textContent = `v${browser.runtime.getManifest().version}`
  $('perm').hidden = await browser.permissions.contains(HOSTS)
  ;[activeTab] = await browser.tabs.query({ active: true, currentWindow: true })
  await Promise.all([render(), renderTab()])
}

onStateChange(() => render())
init().catch(showError)
