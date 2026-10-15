// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseUserList, parseToken, toCsv } from '../extension/lib/user-list.js'

test('parses handles, URLs and ids from free text', () => {
  const text = `@alice, bob
https://x.com/carol/status/1  https://twitter.com/dave?s=20
id:42 1234567890123456789 12345 @alice home not-a-handle!`
  assert.deepEqual(parseUserList(text), [
    { screenName: 'alice' },
    { screenName: 'bob' },
    { screenName: 'carol' },
    { screenName: 'dave' },
    { id: '42' },
    { id: '1234567890123456789' },
    { screenName: '12345' },
  ])
})

test('parses CSV with id / screen_name headers', () => {
  const csv = 'id,screen_name,name\n1,alice,"Alice, A."\n,bob,Bob\n3,,Nobody'
  assert.deepEqual(parseUserList(csv), [
    { id: '1', screenName: 'alice' },
    { screenName: 'bob' },
    { id: '3' },
  ])
})

test('rejects reserved paths and overlong handles', () => {
  assert.equal(parseToken('https://x.com/home'), null)
  assert.equal(parseToken('@abcdefghijklmnopq'), null)
})

test('serialises CSV with escaping', () => {
  assert.equal(toCsv([{ a: 'x,y', b: 'q"z' }], ['a', 'b']), 'a,b\n"x,y","q""z"')
})

test('neutralises spreadsheet formulas in CSV (CSV injection)', () => {
  const csv = toCsv([{ bio: '=HYPERLINK("http://evil")' }, { bio: '+1' }, { bio: '@x' }, { bio: 'ok' }], ['bio'])
  assert.equal(csv, 'bio\n"\'=HYPERLINK(""http://evil"")"\n\'+1\n\'@x\nok')
})
