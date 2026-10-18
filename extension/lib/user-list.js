// SPDX-License-Identifier: GPL-3.0-or-later
// Parsing/serialising helpers for imported and exported user lists.

const RESERVED = new Set([
  'home', 'explore', 'i', 'settings', 'search', 'notifications', 'messages',
  'compose', 'login', 'logout', 'signup', 'tos', 'privacy', 'intent', 'share',
  'hashtag', 'jobs', 'premium', 'communities', 'lists', 'bookmarks',
])

const SCREEN_NAME_RE = /^[A-Za-z0-9_]{1,15}$/
const ID_HEADERS = ['id', 'rest_id', 'user_id', 'userid', 'twitter_id']
const NAME_HEADERS = ['screen_name', 'screenname', 'username', 'handle', 'user']

export function isScreenName(s) {
  return SCREEN_NAME_RE.test(s) && !RESERVED.has(s.toLowerCase())
}

const HOST = String.raw`^(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com`
const USER_ID_LINK = new RegExp(`${HOST}\\/i\\/user\\/(\\d{1,20})(?:[/?#]|$)`, 'i')
const INTENT_LINK = new RegExp(`${HOST}\\/intent\\/(?:user|follow)\\/?\\?([^#\\s]*)`, 'i')
const PROFILE_LINK = new RegExp(`${HOST}\\/([^/?#\\s]+)`, 'i')

// Accepts @handle, handle, profile/status URLs, ID links (x.com/i/user/123),
// intent links (x.com/intent/user?user_id=123 or ?screen_name=name),
// "id:123", or bare IDs that are too long to be a handle (handles are max
// 15 chars and may be numeric).
export function parseToken(raw) {
  let t = raw.trim().replace(/^["']|["']$/g, '')
  if (!t) return null
  const idMatch = /^id[:=](\d+)$/i.exec(t)
  if (idMatch) return { id: idMatch[1] }
  if (/^\d{16,20}$/.test(t)) return { id: t }
  const idLink = USER_ID_LINK.exec(t)
  if (idLink) return { id: idLink[1] }
  const intent = INTENT_LINK.exec(t)
  if (intent) {
    const q = new URLSearchParams(intent[1])
    const id = q.get('user_id')
    if (id && /^\d{1,20}$/.test(id)) return { id }
    const sn = q.get('screen_name')?.replace(/^@/, '')
    return sn && isScreenName(sn) ? { screenName: sn } : null
  }
  const url = PROFILE_LINK.exec(t)
  if (url) t = url[1]
  t = t.replace(/^@/, '')
  if (isScreenName(t)) return { screenName: t }
  return null
}

// Splits CSV text into rows of cells. Quoted cells may hold commas, quotes
// and line breaks (display names can contain all three).
function csvRows(text) {
  const rows = []
  let row = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++ }
      else if (c === '"') quoted = false
      else cur += c
    } else if (c === '"') quoted = true
    else if (c === ',') { row.push(cur); cur = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(cur); cur = ''
      if (row.some((v) => v.trim())) rows.push(row)
      row = []
    } else cur += c
  }
  row.push(cur)
  if (row.some((v) => v.trim())) rows.push(row)
  return rows
}

function parseCsv(text) {
  const [head, ...rows] = csvRows(text)
  const header = head.map((h) => h.trim().toLowerCase())
  const idCol = header.findIndex((h) => ID_HEADERS.includes(h))
  const nameCol = header.findIndex((h) => NAME_HEADERS.includes(h))
  // A queue export can hold pending unblocks; importing those must not block them.
  const actionCol = header.indexOf('action')
  if (idCol < 0 && nameCol < 0) return null
  const items = []
  for (const cols of rows) {
    if (actionCol >= 0 && cols[actionCol]?.trim().toLowerCase() === 'unblock') continue
    const id = idCol >= 0 ? cols[idCol]?.trim() : undefined
    const screenName = nameCol >= 0 ? cols[nameCol]?.trim().replace(/^@/, '') : undefined
    const item = {}
    if (id && /^\d+$/.test(id)) item.id = id
    if (screenName && isScreenName(screenName)) item.screenName = screenName
    if (item.id || item.screenName) items.push(item)
  }
  return items
}

export function parseUserList(text) {
  const first = text.split(/\r?\n/).find((l) => l.trim())
  if (!first) return []
  const items = (first.includes(',') && parseCsv(text)) ||
    text.split(/[\s,;]+/).map(parseToken).filter(Boolean)
  return dedupeItems(items)
}

export function itemKey(item) {
  return item.id ? `id:${item.id}` : `sn:${String(item.screenName ?? '').toLowerCase()}`
}

// Keys of the accounts already in the queue, by ID and by handle, so an account
// that only knows one of the two still matches (same idea as addToQueue's set).
export function queueKeys(queue) {
  const keys = new Set()
  for (const q of queue) {
    keys.add(itemKey(q))
    if (q.id && q.screenName) keys.add(itemKey({ screenName: q.screenName }))
  }
  return keys
}

export function isQueued(user, keys) {
  return keys.has(itemKey(user)) ||
    Boolean(user.id && user.screenName && keys.has(itemKey({ screenName: user.screenName })))
}

export function dedupeItems(items) {
  const seen = new Set()
  return items.filter((it) => {
    const k = itemKey(it)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

function csvCell(v) {
  let s = v === undefined || v === null ? '' : Array.isArray(v) ? v.join('; ') : String(v)
  // Neutralise spreadsheet formulas (CSV injection): bios are attacker-controlled.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function toCsv(rows, columns) {
  return [
    columns.join(','),
    ...rows.map((r) => columns.map((c) => csvCell(r[c])).join(',')),
  ].join('\n')
}
