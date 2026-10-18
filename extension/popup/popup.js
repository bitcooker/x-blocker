// SPDX-License-Identifier: GPL-3.0-or-later
import { send, stateLabel, onStateChange, hydrateIcons } from '../lib/dom.js'
import { browser } from '../lib/compat.js'

const $ = (id) => document.getElementById(id)
const nf = new Intl.NumberFormat()
const HOSTS = { origins: ['https://x.com/*', 'https://api.x.com/*'] }
let activeTab = null

function showError(e) {
  $('error').hidden = !e
  $('error-text').textContent = e ? String(e.message ?? e) : ''
}

async function render() {
  const { runner, counts } = await send('state:get')
  $('status').textContent = stateLabel(runner)
  $('status').dataset.state = runner.state
  const active = runner.state === 'running' || runner.state === 'cooldown'
  const progress = active || runner.state === 'paused'
    ? `${runner.done} blocked · ${runner.unblocked ? `${runner.unblocked} unblocked · ` : ''}${runner.skipped} skipped · ${runner.failed} failed` : ''
  $('message').hidden = !(runner.message || progress)
  $('message').textContent = runner.message || progress
  $('c-total').textContent = nf.format(counts.blocked)
  $('c-queue').textContent = nf.format(counts.queue)
  $('c-24h').textContent = nf.format(counts.last24h)
  $('c-blocked').textContent = `${nf.format(counts.blocked)} blocked · v${browser.runtime.getManifest().version}`
  $('start').hidden = active
  $('pause').hidden = !active
  $('start').disabled = counts.queue === 0
  $('start').querySelector('span').textContent = runner.state === 'paused' ? 'Resume blocking' : 'Start blocking'
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
  $('c-blocked').title = `X Blocker v${browser.runtime.getManifest().version}`
  $('perm').hidden = await browser.permissions.contains(HOSTS)
  ;[activeTab] = await browser.tabs.query({ active: true, currentWindow: true })
  if (activeTab?.url?.startsWith('https://x.com/')) {
    const ping = await browser.tabs.sendMessage(activeTab.id, { type: 'tab:ping' }).catch(() => null)
    $('tab-hint').hidden = !ping?.loggedIn
    if (!ping) showError('Reload this x.com tab so X Blocker can attach to it.')
    else if (!ping.loggedIn) showError('You are not logged in to x.com in this tab.')
  }
  await render()
}

onStateChange(() => render())
init().catch(showError)
