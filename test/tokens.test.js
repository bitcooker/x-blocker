// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../extension/ui/tokens.js', import.meta.url), 'utf8')

function load(protocol) {
  const appended = []
  const ctx = {
    location: { protocol },
    document: { createElement: () => ({}), head: { append: (s) => appended.push(s) } },
  }
  ctx.globalThis = ctx
  vm.createContext(ctx)
  vm.runInContext(source, ctx)
  return { style: ctx.XB_STYLE, appended }
}

test('x.com themes follow data-theme, extension pages follow the OS', () => {
  const { style, appended } = load('https:')
  assert.equal(appended.length, 0, 'content scripts only define the styles')
  const css = style.tokens('.wrap')
  assert.match(css, /\.wrap\{[^}]*--danger:#f4212e[^}]*--bg:#ffffff/)
  assert.match(css, /\.wrap\[data-theme=dim\]\{[^}]*--bg:#15202b/)
  assert.match(css, /\.wrap\[data-theme=dark\]\{[^}]*--bg:#000000/)
  assert.match(style.tokens(':root', 'os'), /@media \(prefers-color-scheme:dark\)\{:root\{[^}]*--bg:#000000/)
})

test('extension pages apply the tokens and components themselves', () => {
  const { appended } = load('chrome-extension:')
  assert.equal(appended.length, 1)
  assert.match(appended[0].textContent, /:root\{.*\.btn\{/s)
})

test('every theme defines the same variables', () => {
  const { style } = load('https:')
  const keys = Object.values(style.THEMES).map((t) => Object.keys(t).sort().join())
  assert.equal(new Set(keys).size, 1)
})
