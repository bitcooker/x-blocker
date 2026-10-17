# X Blocker

A browser extension for **Firefox** and **Chrome** (Manifest V3) that mass-blocks accounts on x.com.

- **Collect**: as you browse any list on x.com (followers, likes, reposts,
  replies, search results, lists, communities…), every account in X's API
  responses is collected automatically. An auto-scroll helper loads long lists for you.
- **Import**: paste or load @handles, profile URLs, numeric IDs (`id:123`) or a
  CSV with `id` / `screen_name` columns.
- **Queue**: blocks run one at a time with a delay plus random jitter. Progress is
  saved after every block, so you can pause, reload or restart the browser and resume.
  Rate limits (HTTP 429) trigger an escalating cooldown, and a daily safety
  limit (450 per 24 h by default) keeps the account under X's threshold.
- **Safety**: never blocks yourself, and by default skips accounts you follow or
  that follow you. You can also keep a whitelist and choose to skip verified accounts.
- **Export**: collected, queued and blocked lists can be exported as CSV.

## Install

**Firefox (128+):** install from
[addons.mozilla.org](https://addons.mozilla.org/firefox/addon/x-blocker/).
Updates arrive automatically.

**Chrome, Edge, Brave, Vivaldi, Opera (Chromium 121+):** the extension is not
in the Chrome Web Store. Install it from GitHub instead:

1. Download `x-blocker-chrome-<version>.zip` from the
   [latest release](https://github.com/bitcooker/x-blocker/releases/latest)
   and extract it to a folder you will keep.
2. Open `chrome://extensions` (`edge://extensions` in Edge) and switch on
   **Developer mode**.
3. Click **Load unpacked** and select the extracted folder.

To update, replace the folder's contents with the new release and click the
reload icon on the extension's card. Settings and data are kept as long as you
use the same folder. Chromium may show a reminder that developer-mode extensions
are enabled. That's expected for extensions installed this way.

X Blocker is an independent project and is not affiliated with or
endorsed by X Corp.

## How it works with x.com

x.com is served by the **"x-web" client** (ES modules from
`abs.twimg.com/x-web/…`, Relay persisted queries, API on `api.x.com`). The
extension is built around how that client works, and avoids anything that
breaks when X ships a new build:

1. **X's own request signing.** Every API call needs an
   `x-client-transaction-id` header. Instead of re-implementing the algorithm,
   the MAIN-world script loads X's own signing module (`assets/sign.*.js`, the
   same file the x-web client imports) and calls `(await mod.default())(path, method)`.
   When X changes the algorithm, the extension picks up the new one automatically. The module URL
   is validated to be a first-party `abs.twimg.com/x-web/…/sign.*.js` chunk, and it
   only runs inside x.com's own page context.
2. **Runtime discovery with fallbacks.** Persisted-query IDs
   (`blockUserMutation`, `intentFollowUserByScreenNameQuery`) and the web bearer
   token are read from the x-web chunks the page has already loaded. Startup and
   entry chunks are searched first. A lazy chunk that isn't loaded yet
   (`block-user-*.js`) is located through the chunk map. Results are cached in
   memory for the page's lifetime, and last-known IDs serve as fallbacks.
3. **Passive collection.**
   - **Firefox:** users are collected in the background with
     `webRequest.filterResponseData`, which passively reads GraphQL response bodies.
     `fetch` and XHR on x.com are never touched.
   - **Chrome:** MV3 has no API for reading response bodies. A small MAIN-world
     script (`content/capture-hook.js`, Chrome build only) wraps `fetch`/XHR at
     `document_start`. It clones X's GraphQL responses without altering them and
     forwards them to the background. Private operations are skipped before any
     body is read.
4. **Shape-agnostic parsing.** Any object with `rest_id` and a screen name
   (`core.screen_name` or `legacy.screen_name`) is treated as a user, with
   relationship data from `relationship_perspectives`. No specific endpoint
   layout is assumed.
5. **Page-aware lists.** The URL determines which list is being viewed
   (followers, following, replies, likes, reposts, quotes, search, list or
   community members). Only accounts from that list in the main column are
   offered for mass blocking, and always through a review step.

## Architecture

```
extension/                 source; manifest is the Firefox flavour (≥128)
  manifest.json
  background.js            state owner: storage, queue, skip rules, rate limits,
                           response capture (Firefox event page / Chrome service worker)
  content/main-world.js    MAIN world: X API calls (block / resolve handle)
                           with X's own signer; answers postMessage commands
  content/capture-hook.js  MAIN world, Chrome only: observes X's GraphQL responses
  content/bridge.js        isolated world: relays between extension and page,
                           runs the queue loop and auto-scroll
  content/page-ui.js       isolated world: in-page buttons, panel, review dialog
  lib/compat.js            browser/chrome API shim and cross-browser messaging
  lib/extract-users.js     user extraction from API JSON
  lib/user-list.js         import parsing / CSV export
  lib/dom.js               safe DOM helpers (no innerHTML)
  popup/                   quick status & actions
  dashboard/               full UI (collected, queue, import, blocked, log, settings)
scripts/build.mjs          builds dist/firefox and dist/chrome (Chrome manifest is derived)
scripts/version.mjs        bumps the version in manifest, package.json and lockfile
scripts/check-version.mjs  verifies versions agree (and match a release tag)
scripts/changelog.mjs      release notes from Conventional Commits
.github/                   CI, release pipeline and Dependabot
test/                      node:test unit and DOM tests (VM + linkedom)
```

Design notes:

- The **background script is the single writer** of all state, and every
  read-modify-write is serialised. UI pages and content scripts only send messages.
- The **runner tab pulls one item at a time** (`runner:next`) and reports the
  result. Items leave the queue only after X confirms the block, so a crash never loses work.
- The background accepts **runner messages only from the tab that holds the
  current run token**, and content scripts cannot call UI/admin actions.
- **Cross-browser messaging** goes through `sendResponse` (Chrome ignores
  Promises returned from `onMessage`). Errors travel back as `{ __error }` and are re-thrown
  on the sending side.
- **Least privilege**: `storage` and `unlimitedStorage` (Chrome caps storage at
  10 MB otherwise), plus `webRequest*` on Firefox only, for `x.com` /
  `api.x.com`. Nothing is sent anywhere except to X, and there is no telemetry.

## Develop

```sh
npm install
npm test               # unit + DOM tests
npm run lint           # web-ext lint of the Firefox build (one expected warning:
                       # the validated dynamic import of X's signer)
npm start              # Firefox with the extension loaded (from extension/)
npm run start:chrome   # Chromium with the Chrome build loaded
npm run build          # dist/firefox and dist/chrome
npm run package        # zips both builds into dist/
```

Manual install:

- **Firefox:** `about:debugging#/runtime/this-firefox` → *Load Temporary Add-on…*
  → choose `extension/manifest.json` (or `dist/firefox/manifest.json`).
  Host access is opt-in in Firefox MV3. If the popup says so, click
  **Grant access**, then reload your x.com tab.
- **Chromium (Chrome, Edge, Brave…):** run `npm run build`, open `chrome://extensions`,
  enable *Developer mode* → *Load unpacked* → choose `dist/chrome`. Chrome 121 or
  newer is required.

## Releasing

Releases are automated with GitHub Actions:

| Workflow | Runs on | Does |
| --- | --- | --- |
| **CI** (`ci.yml`) | push to `main`, pull requests | version check, tests, lint, builds both packages (artifacts) |
| **Prepare release** (`prepare-release.yml`) | manual: *Actions → Prepare release → Run* | bumps the version (`patch` / `minor` / `major` / `X.Y.Z`), commits `chore(release): vX.Y.Z`, tags, pushes, then runs **Release** |
| **Release** (`release.yml`) | a pushed `vX.Y.Z` tag, or called by Prepare release | checks the tag matches the version, tests, lints, packages, creates the GitHub Release and submits the Firefox build to AMO |
| **Dependabot** (`dependabot.yml`) | weekly | updates npm dev dependencies and actions |

Where each build goes:

| Browser | Channel | How users get updates |
| --- | --- | --- |
| Firefox | [addons.mozilla.org](https://addons.mozilla.org/firefox/addon/x-blocker/), listed | automatically, after Mozilla's review |
| Chromium browsers | `x-blocker-chrome-X.Y.Z.zip` on GitHub Releases | manually (see [Install](#install)) |

Every GitHub Release has generated notes (grouped Conventional Commits), install
instructions and both zips.

To release from the command line instead of the Actions button:
```sh
node scripts/version.mjs patch                     # updates manifest, package.json, lockfile
git commit -am "chore(release): v0.1.1" && git tag -a v0.1.1 -m "X Blocker v0.1.1"
git push origin main && git push origin v0.1.1     # push the tag separately so it triggers Release
```

While the project is at 0.x, use `patch` for fixes and `minor` for features or
breaking changes.

### Firefox Add-ons (AMO)

The AMO job needs two repository secrets (*Settings → Secrets and variables →
Actions*). Without them it's skipped with a notice.

| Secret | Value |
| --- | --- |
| `AMO_JWT_ISSUER` | *JWT issuer* from AMO → Developer Hub → *Tools → Manage API Keys* |
| `AMO_JWT_SECRET` | *JWT secret* from the same page (shown only once) |

How it works:
- `scripts/amo-metadata.mjs` asks AMO whether the add-on (`x-blocker@bitcooker`)
  exists yet.
  - **First release:** submits the full listing from `amo-metadata.json`
    (summary, description, categories, license, notes for reviewers).
  - **Later releases:** submits the new version with only its license and
    reviewer notes, so edits made to the listing on the AMO website are never
    overwritten.
- Versions are submitted for review and published once Mozilla approves them.
  The workflow does not wait for approval.
- After the first submission, add screenshots and a privacy policy on the AMO
  website. Those can't come from the metadata file.
- The Firefox ID `x-blocker@bitcooker` is permanent. Never change it.
- The code is not minified or bundled, so no separate source upload is needed.
- If `main` is protected, allow `github-actions[bot]` to push, or use the
  command-line flow above.

## Rate limits (defaults)

X tolerates roughly **500 blocks per rolling 24 hours**. Beyond that it answers
HTTP 429 and may **force-logout the session**. The defaults stay well inside that limit:

| Setting | Default | Why |
| --- | --- | --- |
| Delay between blocks | 4 s (min 2 s) | human-like pace |
| Random extra delay | 0–4 s | avoids perfectly regular timing (avg ≈ 6 s per block) |
| Daily safety limit | 450 / 24 h | headroom under ~500; includes quick blocks; queue waits, then resumes |
| Cooldown after 429 | 15 min, doubling per repeat, max 4 h | backs off instead of hammering X |
| Skipped accounts | 0.8 s pause, no block delay | already-blocked or protected accounts cost no wait |

Account-level errors (401 logged out, 403 locked/challenged, X error codes
32/64/215/326) stop the queue immediately.

## Security & privacy

- **Nothing leaves your browser** except your own requests to X. There is no
  analytics, no remote server and no remote code. The only external code
  executed is X's own signing module, inside x.com's page, from
  `abs.twimg.com/x-web/…/sign.*.js` (URL validated).
- **Private traffic is never read.** Response capture skips DM, chat,
  notification, account, settings, payment and similar operations on both
  browsers. On Chrome this check happens inside the page, before a body is read,
  and again in the background.
- **Data minimisation.** Collected profiles expire after 30 days. Settings has a
  one-click *Delete all data*.
- **Wrong-target protections.**
  - An `@handle` only counts if it links to that profile, so a display name like "@yourfriend" can't redirect a block.
  - Buttons are re-checked when X re-uses a row for another account.
  - @mentions never get buttons.
  - Lookup results must match the requested handle.
- **CSV exports** neutralise spreadsheet formulas (CSV injection).
- **Avatars** are only accepted from X's image CDN.
- **Message boundaries.** The background only accepts queue control from the tab that holds the run token. Content scripts cannot call dashboard/admin actions. All inputs are validated (numeric IDs, 1–15 character handles).

Known trade-offs:
- The MAIN-world command channel (`window.postMessage`) is visible to x.com's
  own scripts. Those scripts already have full access to your session, so this
  grants nothing new, but X *could* detect the extension, as it could detect any
  extension that adds buttons to its page.
- On Chrome, the capture hook wraps `fetch`/XHR in the page. This is more
  detectable than Firefox's passive capture, but it is the only option in Chrome
  MV3. It observes and never modifies requests or responses.

## Usage

On any x.com page you get:

- a red **Block** button next to every account's @handle (user lists, posts, profiles), which blocks that account straight away after you confirm, and
- a floating panel at the bottom right: **X Blocker · N accounts on this page**,
  with **Auto-scroll** (loads the whole list) and **Block all (N)** (queues them
  all and starts blocking in that tab).

For larger jobs, use the dashboard:

1. Log in to x.com and open a list of accounts (e.g. `/<user>/followers`,
   a post's `/likes` or `/retweets`, or a search). Scroll it, or use
   **Auto-scroll this page** in the popup.
2. Open the **Dashboard**, filter and select accounts, and click **Queue selected**.
   You can also paste handles under **Import**.
3. Press **Start blocking**. Keep one x.com tab open while it runs.

The defaults (about 6 s per block, at most 450 per 24 h) are tuned to stay under X's limits; see *Rate limits* above.
On a rate limit the queue cools down and then continues by itself.

## License

Copyright (C) 2026 X Blocker contributors

This program is free software: you can redistribute it and/or modify it under
the terms of the **GNU General Public License v3.0 or later**, as published by the
Free Software Foundation. See [LICENSE](LICENSE) for the full text.

In short:
- You may use, study, modify and share this code, including in commercial settings.
- If you distribute it or a modified version, you must make the full source code
  available under the same license (GPL-3.0-or-later), keep the copyright and
  license notices, and state your changes.
- The software comes with no warranty.
