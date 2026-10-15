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

// Accepts @handle, handle, profile/status URLs, "id:123", or bare IDs that
// are too long to be a handle (handles are max 15 chars and may be numeric).
export function parseToken(raw) {
  let t = raw.trim().replace(/^["']|["']$/g, '')
  if (!t) return null
  const idMatch = /^id[:=](\d+)$/i.exec(t)
  if (idMatch) return { id: idMatch[1] }
  if (/^\d{16,20}$/.test(t)) return { id: t }
  const url = /^(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com\/([^/?#\s]+)/i.exec(t)
  if (url) t = url[1]
  t = t.replace(/^@/, '')
  if (isScreenName(t)) return { screenName: t }
  return null
}

function splitCsvLine(line) {
  const out = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++ }
      else if (c === '"') quoted = false
      else cur += c
    } else if (c === '"') quoted = true
    else if (c === ',') { out.push(cur); cur = '' }
    else cur += c
  }
  out.push(cur)
  return out
}

function parseCsv(lines) {
  const header = splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase())
  const idCol = header.findIndex((h) => ID_HEADERS.includes(h))
  const nameCol = header.findIndex((h) => NAME_HEADERS.includes(h))
  if (idCol < 0 && nameCol < 0) return null
  const items = []
  for (const line of lines.slice(1)) {
    const cols = splitCsvLine(line)
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
  const lines = text.split(/\r?\n/).filter((l) => l.trim())
  if (lines.length === 0) return []
  const items = (lines[0].includes(',') && parseCsv(lines)) ||
    text.split(/[\s,;]+/).map(parseToken).filter(Boolean)
  return dedupeItems(items)
}

export function itemKey(item) {
  return item.id ? `id:${item.id}` : `sn:${String(item.screenName ?? '').toLowerCase()}`
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
  let s = v === undefined || v === null ? '' : String(v)
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
