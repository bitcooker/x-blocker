// SPDX-License-Identifier: GPL-3.0-or-later
// Pulls user records out of any X API JSON payload (new Relay "x-web" shape
// and the legacy GraphQL shape), without depending on a specific endpoint.

const MAX_NODES = 200_000

function str(v) {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function bool(v) {
  return typeof v === 'boolean' ? v : undefined
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

// Only X's own image CDN; anything else could be a tracking pixel.
const AVATAR_RE = /^https:\/\/(?:pbs|abs)\.twimg\.com\//

function avatarUrl(...candidates) {
  return candidates.find((c) => typeof c === 'string' && AVATAR_RE.test(c)) ?? ''
}

export function toUser(o) {
  if (!o || typeof o !== 'object') return null
  const typename = o.__typename
  if (typename !== undefined && typename !== 'User') return null
  const id = str(o.rest_id)
  if (!id || !/^\d+$/.test(id)) return null
  const legacy = o.legacy && typeof o.legacy === 'object' ? o.legacy : {}
  const core = o.core && typeof o.core === 'object' ? o.core : {}
  const screenName = str(core.screen_name) ?? str(legacy.screen_name) ?? str(o.screen_name)
  if (!screenName) return null
  const rel = o.relationship_perspectives && typeof o.relationship_perspectives === 'object'
    ? o.relationship_perspectives
    : {}
  return {
    id,
    screenName,
    name: str(core.name) ?? str(legacy.name) ?? str(o.name) ?? '',
    avatar: avatarUrl(o.avatar?.image_url, legacy.profile_image_url_https),
    description: str(o.profile_bio?.description) ?? str(legacy.description) ?? '',
    followers: num(o.relationship_counts?.followers) ?? num(legacy.followers_count),
    verified: bool(o.is_blue_verified) ?? bool(o.verification?.verified) ?? false,
    following: bool(rel.following) ?? bool(o.is_following) ?? bool(legacy.following),
    followedBy: bool(rel.followed_by) ?? bool(legacy.followed_by),
    blocking: bool(rel.blocking) ?? bool(legacy.blocking),
  }
}

function merge(a, b) {
  const out = { ...a }
  for (const [k, v] of Object.entries(b)) {
    if (v !== undefined && v !== '') out[k] = v
  }
  return out
}

export function extractUsers(json) {
  const found = new Map()
  const stack = [json]
  let visited = 0
  while (stack.length > 0 && visited < MAX_NODES) {
    const node = stack.pop()
    visited++
    if (!node || typeof node !== 'object') continue
    if (Array.isArray(node)) {
      for (const child of node) if (child && typeof child === 'object') stack.push(child)
      continue
    }
    const user = toUser(node)
    if (user) {
      const prev = found.get(user.id)
      found.set(user.id, prev ? merge(prev, user) : user)
    }
    for (const child of Object.values(node)) {
      if (child && typeof child === 'object') stack.push(child)
    }
  }
  return [...found.values()]
}
