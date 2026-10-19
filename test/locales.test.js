// SPDX-License-Identifier: GPL-3.0-or-later
// Every language must be complete, keep the English placeholders, have the
// plural forms its grammar needs, and be loaded everywhere the UI runs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import vm from 'node:vm'

const dir = new URL('../extension/', import.meta.url)
const read = (p) => readFile(new URL(p, dir), 'utf8')
const files = (await readdir(new URL('locales/', dir))).filter((f) => f.endsWith('.js')).sort()
const codes = files.map((f) => f.replace(/\.js$/, ''))

const ctx = vm.createContext({ Intl })
for (const f of files) vm.runInContext(await read(`locales/${f}`), ctx)
vm.runInContext(await read('ui/i18n.js'), ctx)
const { XB_LOCALES: LOCALES, XB_I18N: I18N } = ctx
const en = LOCALES.en

const placeholders = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()
const forms = (v) => (typeof v === 'object' ? Object.values(v) : [v])
const tags = (s) => [...String(s).matchAll(/<\/?([a-z]+)/g)].map((m) => m[1]).sort()

test('the language list matches the locale files', () => {
  assert.deepEqual(Object.keys(I18N.LANGUAGES).sort(), codes)
})

for (const code of codes.filter((c) => c !== 'en')) {
  test(`${code}: every key translated, with the same placeholders and tags`, () => {
    const loc = LOCALES[code]
    assert.deepEqual(Object.keys(loc).filter((k) => !(k in en)), [], 'keys that English does not have')
    assert.deepEqual(Object.keys(en).filter((k) => !(k in loc)), [], 'missing translations')
    for (const [key, value] of Object.entries(loc)) {
      const want = placeholders(forms(en[key])[forms(en[key]).length - 1])
      for (const form of forms(value)) {
        assert.ok(String(form).trim(), `${key} is empty`)
        // A form may drop {n} when the word itself says the number ("one day").
        const got = placeholders(form).filter((p) => p !== 'n')
        assert.deepEqual(got, want.filter((p) => p !== 'n'), `${key}: placeholders`)
        assert.deepEqual(tags(form), tags(forms(en[key])[0]), `${key}: tags`)
      }
    }
  })

  test(`${code}: plural entries cover the language's plural forms`, () => {
    const needed = new Intl.PluralRules(code).resolvedOptions().pluralCategories
    for (const [key, value] of Object.entries(LOCALES[code])) {
      if (typeof en[key] !== 'object') {
        assert.equal(typeof value, 'string', `${key} should be a plain string`)
        continue
      }
      assert.equal(typeof value, 'object', `${key} needs plural forms`)
      for (const cat of needed) assert.ok(cat in value || 'other' in value, `${key}: no "${cat}" or "other" form`)
      assert.ok('other' in value, `${key}: no "other" form`)
    }
  })
}

test('every language is loaded in the background, on x.com and in both pages', async () => {
  const manifest = JSON.parse(await read('manifest.json'))
  const ui = manifest.content_scripts.find((c) => c.js.includes('content/page-ui.js')).js
  const background = await read('background.js')
  const pages = [await read('dashboard/dashboard.html'), await read('popup/popup.html')]
  for (const f of files) {
    assert.ok(ui.includes(`locales/${f}`), `manifest content script: ${f}`)
    assert.ok(background.includes(`'./locales/${f}'`), `background.js: ${f}`)
    for (const page of pages) assert.ok(page.includes(`../locales/${f}`), `page: ${f}`)
  }
  assert.ok(ui.indexOf('ui/i18n.js') < ui.indexOf('content/page-ui.js'))
})

test('Persian uses Persian digits, right-to-left and isolated handles', () => {
  I18N.setLanguage('fa')
  assert.equal(I18N.dir, 'rtl')
  assert.equal(I18N.num(2592), '۲٬۵۹۲')
  assert.equal(I18N.isolate('@alice'), '\u2068@alice\u2069')
  // A number after Latin text stays on its own, not glued to the Latin run.
  ctx.XB_LOCALES.fa['panel.fab.loaded'] ??= 'X Blocker، {count} بارگذاری‌شده'
  assert.match(I18N.t('panel.fab.loaded', { count: 6 }), /\u2068۶\u2069/)
  I18N.setLanguage('de')
  assert.equal(I18N.dir, 'ltr')
  // Left-to-right text gets no isolation marks.
  assert.equal(I18N.t('time.minutes', { n: 5 }), '~5 Min.')
  assert.equal(I18N.num(2592), '2.592')
  I18N.setLanguage('en')
})

test('plural forms are picked by the count, and missing keys fall back to English', () => {
  I18N.setLanguage('en')
  assert.equal(I18N.t('time.days', { n: 1 }), '~1 day')
  assert.equal(I18N.t('time.days', { n: 3 }), '~3 days')
  ctx.XB_LOCALES.xx = {}
  assert.equal(I18N.t('no.such.key'), 'no.such.key')
})

test('strings with tags become real elements, never parsed HTML', async () => {
  const { parseHTML } = await import('linkedom')
  const { document } = parseHTML('<p data-i18n-html="k"></p>')
  const c = vm.createContext({ Intl, document })
  vm.runInContext(await read('ui/i18n.js'), c)
  c.XB_LOCALES.en = { k: 'Use <code>id:1</code> or <b>@a</b> <img src=x onerror=alert(1)>' }
  c.XB_I18N.localize(document)
  const p = document.querySelector('p')
  assert.equal(p.querySelector('code').textContent, 'id:1')
  assert.equal(p.querySelector('b').textContent, '@a')
  assert.equal(p.querySelector('img'), null)
})
