// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nextVersion } from '../scripts/version.mjs'
import { groupCommits } from '../scripts/changelog.mjs'

test('bumps semantic versions', () => {
  assert.equal(nextVersion('1.6.0', 'patch'), '1.6.1')
  assert.equal(nextVersion('1.6.3', 'minor'), '1.7.0')
  assert.equal(nextVersion('1.6.3', 'major'), '2.0.0')
  assert.equal(nextVersion('1.6.3', '1.10.0'), '1.10.0')
  assert.throws(() => nextVersion('1.6.3', '1.6.3'), /greater/)
  assert.throws(() => nextVersion('1.6.3', 'v2'), /Expected/)
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
