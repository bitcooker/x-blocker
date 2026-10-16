// SPDX-License-Identifier: GPL-3.0-or-later
// Writes Markdown release notes from Conventional Commits between two refs.
// Usage: node scripts/changelog.mjs <tag> [previous-tag]
// Without previous-tag, the latest earlier v* tag is used, or the first commit.
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()

const SECTIONS = [
  ['feat', 'Features'],
  ['fix', 'Bug fixes'],
  ['perf', 'Performance'],
  ['security', 'Security'],
  ['refactor', 'Refactoring'],
  ['docs', 'Documentation'],
  ['test', 'Tests'],
  ['build', 'Build & CI'],
  ['ci', 'Build & CI'],
  ['chore', 'Maintenance'],
]
const SUBJECT = /^(\w+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/

export function groupCommits(lines) {
  const groups = new Map()
  const breaking = []
  for (const line of lines) {
    const [hash, subject = ''] = line.split('\t')
    const m = SUBJECT.exec(subject)
    if (m && m[1] === 'chore' && m[2] === 'release') continue // version bump commits
    const type = m?.[1] ?? 'other'
    const title = SECTIONS.find(([t]) => t === type)?.[1] ?? 'Other changes'
    const text = m ? `${m[2] ? `**${m[2]}:** ` : ''}${m[4]}` : subject
    const entry = `- ${text} (${hash.slice(0, 7)})`
    if (m?.[3]) breaking.push(entry)
    if (!groups.has(title)) groups.set(title, [])
    groups.get(title).push(entry)
  }
  const order = [...new Set(SECTIONS.map(([, t]) => t)), 'Other changes']
  const out = []
  if (breaking.length) out.push('### ⚠ Breaking changes', ...breaking, '')
  for (const title of order) {
    if (!groups.has(title)) continue
    out.push(`### ${title}`, ...groups.get(title), '')
  }
  return out.join('\n').trim()
}

function main() {
  const [tag, prevArg] = process.argv.slice(2)
  if (!tag) throw new Error('Usage: node scripts/changelog.mjs <tag> [previous-tag]')
  let prev = prevArg
  if (!prev) {
    try {
      prev = git('describe', '--tags', '--abbrev=0', '--match', 'v*', `${tag}^`)
    } catch {
      prev = '' // first release: whole history
    }
  }
  const range = prev ? `${prev}..${tag}` : tag
  const log = git('log', '--no-merges', '--format=%H%x09%s', range)
  const body = groupCommits(log ? log.split('\n') : []) || '_No notable changes._'
  const repo = process.env.GITHUB_REPOSITORY
  const compare = repo && prev ? `\n\n**Full changelog:** https://github.com/${repo}/compare/${prev}...${tag}` : ''
  console.log(`${body}${compare}`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
