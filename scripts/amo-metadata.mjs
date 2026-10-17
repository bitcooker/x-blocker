// SPDX-License-Identifier: GPL-3.0-or-later
// Writes the metadata file for `web-ext sign --amo-metadata`.
// web-ext PUTs the whole file on every submission, so after the add-on exists
// only the "version" part is passed; listing edits made on AMO are preserved.
// Usage: node scripts/amo-metadata.mjs <output.json>
// Env: WEB_EXT_API_KEY (JWT issuer), WEB_EXT_API_SECRET (JWT secret)
import { createHmac, randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const API = 'https://addons.mozilla.org/api/v5'

const b64url = (v) => Buffer.from(v).toString('base64url')

// AMO API auth: HS256 JWT, valid for at most 5 minutes.
export function amoJwt(issuer, secret, now = Math.floor(Date.now() / 1000)) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = b64url(JSON.stringify({ iss: issuer, jti: randomUUID(), iat: now, exp: now + 60 }))
  const signature = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url')
  return `${header}.${payload}.${signature}`
}

export function metadataFor(full, exists) {
  return exists ? { version: full.version } : full
}

async function addonExists(guid, issuer, secret) {
  const res = await fetch(`${API}/addons/addon/${encodeURIComponent(guid)}/`, {
    headers: { Authorization: `JWT ${amoJwt(issuer, secret)}` },
  })
  if (res.ok) return true
  if (res.status === 404) return false
  throw new Error(`AMO lookup failed: HTTP ${res.status} ${await res.text()}`)
}

async function main() {
  const out = process.argv[2]
  const { WEB_EXT_API_KEY: issuer, WEB_EXT_API_SECRET: secret } = process.env
  if (!out || !issuer || !secret) throw new Error('Usage: node scripts/amo-metadata.mjs <out> (needs WEB_EXT_API_KEY/SECRET)')
  const manifest = JSON.parse(await readFile(path.join(root, 'extension/manifest.json'), 'utf8'))
  const guid = manifest.browser_specific_settings.gecko.id
  const full = JSON.parse(await readFile(path.join(root, 'amo-metadata.json'), 'utf8'))
  const exists = await addonExists(guid, issuer, secret)
  await writeFile(out, JSON.stringify(metadataFor(full, exists), null, 2))
  console.log(exists ? `${guid} exists on AMO: submitting a new version only` : `${guid} is new: creating the AMO listing`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e.message)
    process.exit(1)
  })
}
