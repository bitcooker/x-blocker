// SPDX-License-Identifier: GPL-3.0-or-later
// X Blocker translations: one small loader shared by the background, the
// dashboard, the toolbar popup and the in-page UI on x.com.
//
// The browser's own extension i18n follows the browser language only and can't
// be switched at runtime, so the Language setting needs this instead. Strings
// live in locales/<lang>.js; English is the fallback for anything missing.
//
//   t('key', { name: '@alice', n: 3 })  – {name} placeholders; numbers are
//   formatted for the language, and an entry may be { one, other, … } plural
//   forms chosen with Intl.PluralRules by the `n` parameter.
//
// Loaded as a classic script (content scripts, extension pages) or imported
// for its side effect (background module).
(() => {
  'use strict'
  if (globalThis.XB_I18N) return

  const LOCALES = (globalThis.XB_LOCALES ??= {})
  // Each language's name in that language, for the Language setting.
  const LANGUAGES = {
    en: 'English', ar: 'العربية', de: 'Deutsch', es: 'Español', fa: 'فارسی', fr: 'Français', tr: 'Türkçe',
  }
  const RTL = new Set(['ar', 'fa'])
  const STORE_KEY = 'xb-language'
  // Bidi isolation, so an @handle or a number can't scramble a right-to-left sentence.
  const FSI = '\u2068'
  const PDI = '\u2069'

  let lang = 'en'
  let locale = 'en'
  let nf, plurals, rtf, timeFmt, dateFmt, dateTimeFmt

  function browserLanguages() {
    const nav = globalThis.navigator
    return nav ? [...(nav.languages ?? []), nav.language].filter(Boolean) : []
  }

  // 'auto' (or anything unknown) means the first supported browser language.
  function resolve(pref) {
    if (pref && pref !== 'auto' && LANGUAGES[pref]) return { lang: pref, locale: pref }
    for (const tag of browserLanguages()) {
      const base = tag.toLowerCase().split('-')[0]
      // Keep the full tag (de-AT, es-MX) for number and date formats.
      if (LANGUAGES[base]) return { lang: base, locale: tag }
    }
    return { lang: 'en', locale: browserLanguages()[0] ?? 'en' }
  }

  function setLanguage(pref) {
    ;({ lang, locale } = resolve(pref))
    try {
      nf = new Intl.NumberFormat(locale)
    } catch {
      locale = lang
      nf = new Intl.NumberFormat(locale)
    }
    plurals = new Intl.PluralRules(lang)
    rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
    timeFmt = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' })
    dateFmt = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' })
    dateTimeFmt = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' })
    // Extension pages remember the choice so the next page opens in it at once.
    if (isExtensionPage()) {
      try { localStorage.setItem(STORE_KEY, pref ?? 'auto') } catch {}
      applyDocument()
    }
    return lang
  }

  function isExtensionPage() {
    return /^(chrome|moz)-extension:$/.test(globalThis.location?.protocol ?? '') && typeof document !== 'undefined'
  }

  const rtl = () => RTL.has(lang)
  const num = (n) => (typeof n === 'number' && Number.isFinite(n) ? nf.format(n) : '—')
  const isolate = (s) => (rtl() ? `${FSI}${s}${PDI}` : s)

  function t(key, params = {}) {
    let entry = LOCALES[lang]?.[key] ?? LOCALES.en?.[key]
    if (entry == null) return key
    if (typeof entry === 'object') {
      const n = Number(params.n ?? 0)
      entry = entry[n === 0 && entry.zero != null ? 'zero' : plurals.select(n)] ?? entry.other
    }
    // In right-to-left text every value is isolated, numbers included: Persian
    // digits count as "European numbers" to the bidi algorithm, so after Latin
    // text ("X Blocker، ۶") they would otherwise join the left-to-right run.
    return entry.replace(/\{(\w+)\}/g, (m, k) => {
      if (!(k in params)) return m
      const v = params[k]
      return isolate(typeof v === 'number' ? num(v) : String(v))
    })
  }

  // "3 minutes ago", "in 2 hours".
  function ago(at) {
    if (!at) return ''
    const s = Math.round((at - Date.now()) / 1000)
    const abs = Math.abs(s)
    if (abs < 60) return rtf.format(s, 'second')
    if (abs < 3600) return rtf.format(Math.round(s / 60), 'minute')
    if (abs < 86400) return rtf.format(Math.round(s / 3600), 'hour')
    return rtf.format(Math.round(s / 86400), 'day')
  }

  // Rounded estimates: "~25 min", "~3 h 10 min", "~2 days".
  function duration(ms) {
    if (!ms || ms < 60_000) return t('time.underMinute')
    const min = Math.round(ms / 60_000)
    if (min < 60) return t('time.minutes', { n: min })
    const h = Math.floor(min / 60)
    if (h < 48) return min % 60 >= 10 ? t('time.hoursMinutes', { h, m: min % 60 }) : t('time.hours', { n: h })
    return t('time.days', { n: Math.round(h / 24) })
  }

  const time = (at) => timeFmt.format(at)
  const date = (at) => dateFmt.format(at)
  const dateTime = (at) => dateTimeFmt.format(at)

  // Text with <b> and <code> only, built as nodes (never parsed as HTML).
  function rich(s) {
    return s.split(/(<(b|code)>[\s\S]*?<\/\2>)/).filter((part, i) => i % 3 !== 2 && part).map((part) => {
      const m = /^<(b|code)>([\s\S]*)<\/\1>$/.exec(part)
      if (!m) return document.createTextNode(part)
      const el = document.createElement(m[1])
      el.textContent = m[2]
      return el
    })
  }

  // Static HTML: data-i18n="key" sets the text, data-i18n-html="key" allows the
  // few tags our own strings use (<b>, <code>), and
  // data-i18n-attr="placeholder:key title:key" sets attributes.
  function localize(root = document) {
    for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n)
    for (const el of root.querySelectorAll('[data-i18n-html]')) el.replaceChildren(...rich(t(el.dataset.i18nHtml)))
    for (const el of root.querySelectorAll('[data-i18n-attr]')) {
      for (const pair of el.dataset.i18nAttr.split(/\s+/).filter(Boolean)) {
        const [attr, key] = pair.split(':')
        el.setAttribute(attr, t(key))
      }
    }
  }

  function applyDocument(root = document.documentElement) {
    root.lang = lang
    root.dir = rtl() ? 'rtl' : 'ltr'
  }

  globalThis.XB_I18N = {
    LANGUAGES, t, num, ago, duration, time, date, dateTime, localize, applyDocument, setLanguage, isolate,
    get lang() { return lang },
    get locale() { return locale },
    get dir() { return rtl() ? 'rtl' : 'ltr' },
    get rtl() { return rtl() },
  }

  let saved = 'auto'
  if (isExtensionPage()) {
    try { saved = localStorage.getItem(STORE_KEY) ?? 'auto' } catch {}
  }
  setLanguage(saved)
})()
