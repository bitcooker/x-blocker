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
