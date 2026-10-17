// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseUserList, parseToken, isQueued, queueKeys, toCsv } from '../extension/lib/user-list.js'

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

test('parses user-ID links and intent links', () => {
  const text = `https://x.com/i/user/14898047
https://x.com/i/user/36305606
https://x.com/i/user/40049922
twitter.com/i/user/12/ www.x.com/i/user/34?s=20 http://mobile.twitter.com/i/user/56#top
https://x.com/intent/user?user_id=78 https://twitter.com/intent/follow?screen_name=@alice&lang=en
https://x.com/i/user/notanumber https://x.com/i/user/ https://x.com/intent/user?user_id=abc https://evil.com/i/user/99`
  assert.deepEqual(parseUserList(text), [
    { id: '14898047' },
    { id: '36305606' },
    { id: '40049922' },
    { id: '12' },
    { id: '34' },
    { id: '56' },
    { id: '78' },
    { screenName: 'alice' },
  ])
})

test('queued accounts are matched by ID or handle, either way round', () => {
  const keys = queueKeys([{ id: '1', screenName: 'Alice' }, { screenName: 'bob' }, { id: '3' }])
  assert.equal(isQueued({ id: '1', screenName: 'someone-else' }, keys), true)
  assert.equal(isQueued({ id: '9', screenName: 'alice' }, keys), true)
  assert.equal(isQueued({ id: '9', screenName: 'BOB' }, keys), true)
  assert.equal(isQueued({ id: '3', screenName: 'carol' }, keys), true)
  assert.equal(isQueued({ id: '9', screenName: 'carol' }, keys), false)
  assert.equal(isQueued({ screenName: 'carol' }, keys), false)
})
