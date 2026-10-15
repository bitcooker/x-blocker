// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractUsers } from '../extension/lib/extract-users.js'

test('extracts users from the new x-web Relay shape', () => {
  const payload = {
    data: {
      viewer_v2: {
        timeline: {
          instructions: [{
            entries: [
              {
                content: {
                  user_results: {
                    result: {
                      __typename: 'User',
                      id: 'VXNlcjoxMjM=',
                      rest_id: '123',
                      core: { screen_name: 'spam_bot', name: 'Spam Bot' },
                      avatar: { image_url: 'https://pbs.twimg.com/a.jpg' },
                      relationship_perspectives: { following: false, followed_by: true, blocking: false },
                      is_blue_verified: true,
                      relationship_counts: { followers: 42 },
                    },
                  },
                },
              },
              { content: { user_results: { result: { __typename: 'UserUnavailable', rest_id: '9' } } } },
            ],
          }],
        },
      },
    },
  }
  assert.deepEqual(extractUsers(payload), [{
    id: '123',
    screenName: 'spam_bot',
    name: 'Spam Bot',
    avatar: 'https://pbs.twimg.com/a.jpg',
    description: '',
    followers: 42,
    verified: true,
    following: false,
    followedBy: true,
    blocking: false,
  }])
})

test('extracts users from the legacy GraphQL shape and merges duplicates', () => {
  const legacyUser = (extra) => ({
    __typename: 'User',
    rest_id: '456',
    legacy: { screen_name: 'old_user', name: 'Old', followers_count: 7, ...extra },
  })
  const users = extractUsers({ a: [legacyUser({}), legacyUser({ description: 'hello', blocking: true })] })
  assert.equal(users.length, 1)
  assert.equal(users[0].screenName, 'old_user')
  assert.equal(users[0].description, 'hello')
  assert.equal(users[0].blocking, true)
  assert.equal(users[0].followers, 7)
})

test('ignores non-user objects and malformed ids', () => {
  assert.deepEqual(extractUsers({ rest_id: 'abc', core: { screen_name: 'x' } }), [])
  assert.deepEqual(extractUsers({ __typename: 'Tweet', rest_id: '1', core: { screen_name: 'x' } }), [])
  assert.deepEqual(extractUsers(null), [])
})

test('drops avatar URLs that are not on X\'s image CDN', () => {
  const [u] = extractUsers({
    __typename: 'User', rest_id: '7', core: { screen_name: 'a' },
    avatar: { image_url: 'https://tracker.example/pixel.gif' },
  })
  assert.equal(u.avatar, '')
})
