// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nextVersion } from '../scripts/version.mjs'
import { groupCommits } from '../scripts/changelog.mjs'

test('bumps semantic versions', () => {
  assert.equal(nextVersion('0.1.0', 'patch'), '0.1.1')
  assert.equal(nextVersion('0.1.3', 'minor'), '0.2.0')
  assert.equal(nextVersion('0.1.3', 'major'), '1.0.0')
  assert.equal(nextVersion('0.1.3', '0.10.0'), '0.10.0')
  assert.throws(() => nextVersion('0.1.3', '0.1.3'), /greater/)
  assert.throws(() => nextVersion('0.1.3', 'v2'), /Expected/)
})

test('groups conventional commits into release notes', () => {
  const notes = groupCommits([
    'aaaaaaa1\tfeat(ui): add review dialog',
    'bbbbbbb2\tfix: keep pill beside Follow',
    'ccccccc3\tchore(release): v1.6.1',
    'ddddddd4\tfeat!: drop Firefox 115',
    'eeeeeee5\tUpdate stuff',
  ])
  assert.equal(notes, [
    '### ⚠ Breaking changes',
    '- drop Firefox 115 (ddddddd)',
    '',
    '### Features',
    '- **ui:** add review dialog (aaaaaaa)',
    '- drop Firefox 115 (ddddddd)',
    '',
    '### Bug fixes',
    '- keep pill beside Follow (bbbbbbb)',
    '',
    '### Other changes',
    '- Update stuff (eeeeeee)',
  ].join('\n'))
})

test('AMO JWT is HS256-signed with a short expiry', async () => {
  const { createHmac } = await import('node:crypto')
  const { amoJwt } = await import('../scripts/amo-metadata.mjs')
  const token = amoJwt('user:1:2', 'secret', 1000)
  const [h, p, sig] = token.split('.')
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'HS256', typ: 'JWT' })
  const payload = JSON.parse(Buffer.from(p, 'base64url'))
  assert.equal(payload.iss, 'user:1:2')
  assert.equal(payload.exp - payload.iat, 60)
  assert.equal(sig, createHmac('sha256', 'secret').update(`${h}.${p}`).digest('base64url'))
})

test('only the version part is sent once the add-on exists', async () => {
  const { metadataFor } = await import('../scripts/amo-metadata.mjs')
  const full = { summary: { 'en-US': 's' }, categories: ['other'], version: { license: 'MIT' } }
  assert.deepEqual(metadataFor(full, false), full)
  assert.deepEqual(metadataFor(full, true), { version: { license: 'MIT' } })
})
