# Contributing

`main` is protected: open a pull request. It needs a passing CI and one approval.
Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`,
`fix(panel):`, `docs:`…); release notes are generated from them.

## Develop

```sh
npm install
npm test               # unit + DOM tests
npm run lint           # web-ext lint (one expected warning: the validated import of X's signer)
npm start              # Firefox with the extension loaded
npm run start:chrome   # Chromium with the Chrome build loaded
npm run build          # dist/firefox and dist/chrome
```

## Layout

```
extension/
  background.js            state owner: storage, queue, skip rules, rate limits, response capture
  content/main-world.js    X API calls (block / resolve handle) using X's own request signer
  content/capture-hook.js  Chrome only: observes X's GraphQL responses
  content/bridge.js        relays between extension and page; queue loop and auto-scroll
  content/page-ui.js       in-page buttons, panel, review dialog
  lib/                     browser shim, user extraction, import/export, DOM helpers
  popup/  dashboard/       extension UI
scripts/                   build, versioning, changelog, AMO metadata
test/                      node:test unit and DOM tests
```

The background script is the only writer of state. The queue removes an account
only after X confirms the block.

## Translations

UI strings live in `extension/locales/<lang>.js`, with English (`en.js`) as the
source. See [extension/locales/README.md](extension/locales/README.md) for the
format and how to add a language. Corrections from native speakers are very
welcome; `npm test` checks that every language is complete.

## Release (maintainers)

**One click:** Actions → **Prepare release** → **Run workflow**, with `patch`,
`minor`, `major` or an explicit `X.Y.Z`. It bumps `manifest.json`,
`package.json` and `package-lock.json`, runs the tests, commits
`chore(release): vX.Y.Z`, tags it and starts the Release workflow.

`main` is protected, so the token that pushes the bump has to get past the
ruleset. A write deploy key titled **Release workflow (github-actions)** is
listed under the ruleset's bypass actors, and its private half is stored as the
`RELEASE_SSH_KEY` secret. Rotating it means replacing it in both places. Without
a working key the job stops before the tag is pushed, so a failed run leaves
nothing half-released behind.

**By hand:**

```sh
node scripts/version.mjs minor          # or patch / major / X.Y.Z
git commit -am "chore(release): vX.Y.Z" && git tag -a vX.Y.Z -m "X Blocker vX.Y.Z"
git push origin main && git push origin vX.Y.Z
```

Pushing the tag runs the Release workflow: it creates the GitHub Release and
submits the Firefox build to addons.mozilla.org (needs the `AMO_JWT_ISSUER` and
`AMO_JWT_SECRET` secrets). The Firefox ID `x-blocker@bitcooker` must never change.
