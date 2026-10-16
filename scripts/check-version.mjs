// SPDX-License-Identifier: GPL-3.0-or-later
// Verifies that every recorded version agrees, and optionally matches a tag.
// Usage: node scripts/check-version.mjs [vX.Y.Z]
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const read = async (f) => JSON.parse(await readFile(path.join(root, f), 'utf8'))

const [manifest, pkg, lock] = await Promise.all([
  read('extension/manifest.json'),
  read('package.json'),
  read('package-lock.json'),
])
const versions = {
  'extension/manifest.json': manifest.version,
  'package.json': pkg.version,
  'package-lock.json': lock.packages?.['']?.version ?? lock.version,
}
const tag = process.argv[2]
if (tag) versions[`tag ${tag}`] = tag.replace(/^v/, '')

const distinct = new Set(Object.values(versions))
if (distinct.size !== 1) {
  console.error('Version mismatch:')
  for (const [where, v] of Object.entries(versions)) console.error(`  ${where}: ${v}`)
  process.exit(1)
}
console.log(manifest.version)
