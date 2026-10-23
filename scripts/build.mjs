// SPDX-License-Identifier: GPL-3.0-or-later
// Produces browser-specific builds from extension/:
//   dist/firefox  – the source manifest as-is (event page + webRequest capture)
//   dist/chrome   – service worker background, MAIN-world capture hook, no webRequest
// Usage: node scripts/build.mjs [firefox|chrome]...   (default: both)
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const src = path.join(root, 'extension')
const CHROME_ONLY = ['content/capture-hook.js']
const MATCHES = ['https://x.com/*']

function chromeManifest(m) {
  const out = structuredClone(m)
  delete out.browser_specific_settings
  out.minimum_chrome_version = '121'
  out.background = { service_worker: out.background.scripts[0], type: 'module' }
  // Chrome MV3 has no blocking webRequest / filterResponseData; the capture
  // hook takes over, so those permissions are dropped entirely.
  out.permissions = out.permissions.filter((p) => !p.startsWith('webRequest'))
  // The hook must observe X's requests from the very start, and runs after
  // main-world.js so that script keeps an untouched fetch reference.
  const main = out.content_scripts.find((c) => c.world === 'MAIN')
  main.js = [...main.js, ...CHROME_ONLY]
  main.matches = MATCHES
  return out
}

async function build(target) {
  const dest = path.join(root, 'dist', target)
  await rm(dest, { recursive: true, force: true })
  await mkdir(dest, { recursive: true })
  const skip = target === 'firefox' ? new Set(CHROME_ONLY.map((f) => path.join(src, f))) : new Set()
  // Documentation stays in the repository; it has no place in the package.
  await cp(src, dest, { recursive: true, filter: (f) => !skip.has(f) && !f.endsWith('.md') })
  const manifest = JSON.parse(await readFile(path.join(src, 'manifest.json'), 'utf8'))
  const out = target === 'chrome' ? chromeManifest(manifest) : manifest
  await writeFile(path.join(dest, 'manifest.json'), JSON.stringify(out, null, 2) + '\n')
  console.log(`built ${path.relative(root, dest)} (v${out.version})`)
}

const targets = process.argv.slice(2)
for (const t of targets.length ? targets : ['firefox', 'chrome']) {
  if (t !== 'firefox' && t !== 'chrome') throw new Error(`Unknown target: ${t}`)
  await build(t)
}
