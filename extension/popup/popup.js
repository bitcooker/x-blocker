// SPDX-License-Identifier: GPL-3.0-or-later
// Toolbar popup: a remote control. The queue (what, how far, how long, pause),
// the safety limits, and what X Blocker can do on the current tab.
import { send, stateLabel, onStateChange, hydrateIcons, fmtNum, fmtDuration, t } from '../lib/dom.js'
import { browser } from '../lib/compat.js'

const $ = (id) => document.getElementById(id)
const HOSTS = { origins: ['https://x.com/*', 'https://api.x.com/*'] }
const i18n = globalThis.XB_I18N
const compact = (n) => new Intl.NumberFormat(i18n.locale, { notation: 'compact', maximumFractionDigits: 1 }).format(n)
const LANG_KEY = 'xb-language'
let activeTab = null

function showError(e) {
  $('error').hidden = !e
  $('error-text').textContent = e ? String(e.message ?? e) : ''
}

const meter = (el, value, max) => { el.style.width = max ? `${Math.min(100, (value / max) * 100)}%` : '0' }

async function render() {
  const { runner, counts, settings, current } = await send('state:get')
  if (followLanguage(settings.language)) return render()
  const active = runner.state === 'running' || runner.state === 'cooldown'
  $('status').textContent = stateLabel(runner)
  $('status').dataset.state = runner.state

  const processed = runner.done + (runner.unblocked ?? 0) + runner.failed + runner.skipped
  const total = processed + counts.queue
  $('now-title').textContent = counts.queue ? (current?.source ?? t('popup.working')) : t('popup.nothingWaiting')
  $('now-title').title = $('now-title').textContent
  const detail = []
  if (counts.queue) {
    detail.push(t('popup.progress', { done: total - counts.queue, total }))
    if (runner.state !== 'paused' && runner.state !== 'error') detail.push(t('popup.left', { time: fmtDuration(counts.etaMs) }))
  }
  if (runner.state === 'cooldown' || runner.state === 'error') detail.push(runner.message)
  $('now-detail').textContent = detail.filter(Boolean).join(t('common.sep')) || t('popup.blockedTotal', { n: counts.blocked })
  $('now-meter').hidden = !counts.queue
  meter($('now-bar'), total - counts.queue, total)

  $('start').hidden = active || !counts.queue
  $('pause').hidden = !active
  $('start').querySelector('span').textContent = t(runner.state === 'paused' ? 'popup.resume' : 'popup.start')

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
    $('tab-hint-text').textContent = t('popup.hint.openList')
    return
  }
  const info = await browser.tabs.sendMessage(activeTab.id, { type: 'tab:page' }).catch(() => null)
  if (!info) {
    $('tab-list').hidden = true
    $('tab-hint').hidden = false
    $('tab-hint-text').textContent = t('popup.hint.reload')
    return
  }
  $('tab-list').hidden = !info.list
  $('tab-hint').hidden = info.list
  if (!info.list) {
    $('tab-hint-text').textContent = t('popup.hint.noList')
    return
  }
  $('tab-label').textContent = info.label
  $('tab-label').title = info.label
  $('tab-detail').textContent = info.ended
    ? t('popup.tab.allLoaded', { n: info.loaded, review: info.reviewable })
    : info.total
      ? t('popup.tab.loadedOf', { n: info.loaded, total: `~${compact(info.total)}`, review: info.reviewable })
      : t('popup.tab.loaded', { n: info.loaded, review: info.reviewable })
  // The same two actions as the panel, started on the page.
  $('tab-review').textContent = info.reviewable ? t('popup.reviewN', { n: info.reviewable }) : t('popup.nothingToReview')
  $('tab-review').disabled = !info.reviewable
  $('tab-load').hidden = info.ended
  $('tab-load').disabled = info.loading
  $('tab-load').textContent = t(info.loading ? 'popup.loading' : 'popup.loadAll')
}

async function onTab(type) {
  await browser.tabs.sendMessage(activeTab.id, { type }).catch(() => {})
  window.close()
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
$('tab-review').addEventListener('click', () => onTab('tab:review'))
$('tab-load').addEventListener('click', () => onTab('tab:loadAll'))
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

// The background owns the Language setting; follow it if this page opened in another.
function followLanguage(pref = 'auto') {
  let saved = 'auto'
  try { saved = localStorage.getItem(LANG_KEY) ?? 'auto' } catch {}
  if (saved === pref) return false
  i18n.setLanguage(pref)
  i18n.localize()
  renderTab().catch(() => {})
  return true
}

async function init() {
  i18n.localize()
  hydrateIcons()
  $('version').textContent = `v${browser.runtime.getManifest().version}`
  $('perm').hidden = await browser.permissions.contains(HOSTS)
  ;[activeTab] = await browser.tabs.query({ active: true, currentWindow: true })
  await Promise.all([render(), renderTab()])
}

onStateChange(() => render())
init().catch(showError)
