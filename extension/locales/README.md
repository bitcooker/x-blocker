# Translations

One file per language, `<code>.js`, with the same keys as `en.js`.
English is the source and the fallback for any missing key.

- Keep `{placeholders}` exactly as they are; numbers are formatted for the language.
- An entry can be plural forms instead of a string: `{ one: '…', other: '…' }`
  (plus `zero`, `two`, `few`, `many` where the language uses them).
- Only `<b>` and `<code>` tags, and only in keys used with `data-i18n-html`.

To add a language: copy `en.js`, translate, list the file in
`manifest.json` (content scripts), `dashboard/dashboard.html`,
`popup/popup.html` and `background.js`, and add its name to `LANGUAGES` in
`ui/i18n.js`. `npm test` checks that every file is complete and wired in.
