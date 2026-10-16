// SPDX-License-Identifier: GPL-3.0-or-later
// Bumps the extension version in every place it is recorded:
// extension/manifest.json (source of truth), package.json and package-lock.json.
// Usage: node scripts/version.mjs <patch|minor|major|X.Y.Z>
// Prints the new version on stdout.
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const files = {
  manifest: path.join(root, 'extension/manifest.json'),
  pkg: path.join(root, 'package.json'),
  lock: path.join(root, 'package-lock.json'),
}
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/

export function nextVersion(current, bump) {
  const m = SEMVER.exec(current)
  if (!m) throw new Error(`Current version "${current}" is not X.Y.Z`)
  const [major, minor, patch] = m.slice(1).map(Number)
  if (bump === 'major') return `${major + 1}.0.0`
  if (bump === 'minor') return `${major}.${minor + 1}.0`
  if (bump === 'patch') return `${major}.${minor}.${patch + 1}`
  if (!SEMVER.test(bump)) throw new Error(`Expected patch, minor, major or X.Y.Z, got "${bump}"`)
  const cmp = (a, b) => a.split('.').map(Number).reduce((r, n, i) => r || n - b.split('.').map(Number)[i], 0)
  if (cmp(bump, current) <= 0) throw new Error(`New version ${bump} must be greater than ${current}`)
  return bump
}

const readJson = async (f) => JSON.parse(await readFile(f, 'utf8'))
const writeJson = (f, v) => writeFile(f, JSON.stringify(v, null, 2) + '\n')

async function main() {
  const bump = process.argv[2]
  if (!bump) throw new Error('Usage: node scripts/version.mjs <patch|minor|major|X.Y.Z>')
  const manifest = await readJson(files.manifest)
  const version = nextVersion(manifest.version, bump)
  manifest.version = version
  await writeJson(files.manifest, manifest)

  const pkg = await readJson(files.pkg)
  pkg.version = version
  await writeJson(files.pkg, pkg)

  const lock = await readJson(files.lock)
  lock.version = version
  if (lock.packages?.['']) lock.packages[''].version = version
  await writeJson(files.lock, lock)

  console.log(version)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e.message)
    process.exit(1)
  })
}
