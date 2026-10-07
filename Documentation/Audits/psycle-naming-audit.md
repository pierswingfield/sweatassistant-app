# Psycle naming audit (read-only)

Scope: `client/` and `server/` (excluding node_modules, dist, server/public, fixtures, Documentation, .git).
Method: grep tokens matching `psycle[A-Za-z0-9_:-]*` (case-insensitive), classified per token by a script
(`A` = gym id / gym file / gym constants, `C` = CSS-class, id, storage, event, export-key shape, `B` = remaining prose
or app-level text). Counts are TOKENS, 6,319 total across 165 files: **A=558, B=405, C=5,356**. Classification is
heuristic; B and A boundaries were spot-checked by reading lines, C is exact for the shapes listed below.

## 1. Root cause

The UI layer was written when the app was "Psycle Assistant", and `psycle-` was the universal namespace prefix for
CSS classes, DOM ids, custom events and localStorage keys. 85 percent of all mentions are that prefix.
`styles.css` (3,283) and `index.html` (444) alone are 59 percent. The gym-specific mentions (A) are correct and
mostly in server tests and `gyms.config.js`. True user-visible copy that wrongly says Psycle is very small.

## 2. Counts per file (top files; full list reproducible with the method above)

| File | A | B | C |
|---|---|---|---|
| client/src/styles.css | 0 | 6 | 3283 |
| client/index.html | 0 | 0 | 444 |
| client/src/ui/timetable.js | 1 | 7 | 365 |
| client/src/ui/settings.js | 1 | 2 | 224 |
| client/src/ui/onboarding.js | 0 | 0 | 191 |
| client/src/main.js | 0 | 0 | 176 |
| client/src/ui/credits.js | 0 | 3 | 103 |
| client/src/ui/bookings.js | 0 | 2 | 72 |
| client/src/ui/gym-settings-section.js | 0 | 0 | 56 |
| client/src/ui/spot-setup.js | 0 | 0 | 51 |
| client/src/ui/booking-chrome.js | 0 | 0 | 47 |
| client/src/ui/calendar-section.js | 0 | 0 | 43 |
| client/src/ui/tooltips.js | 0 | 2 | 41 |
| client/src/ui/autobook.js | 0 | 1 | 30 |
| client/src/ui/modal-nav.js | 0 | 0 | 24 |
| client/src/ui/overlap-modal.js | 0 | 0 | 22 |
| client/src/api.js | 0 | 5 | 13 |
| server/server.js | 0 | 2 | 15 |
| server/test-no-active-gym.js | 43 | 3 | 0 |
| server/test-class-history.js | 38 | 2 | 0 |
| server/test-booking-window-policy.js | 13 | 28 | 0 |
| server/test-relogin-failures.js | 30 | 2 | 0 |
| server/gyms.config.js | 24 | 0 | 0 |
| server/providers/codexfit.js | 21 | 0 | 0 |
| server/db.js | 11 | 14 | 0 |
| server/scheduler.js | 0 | 12 | 0 |
| client/src/lib.js | 0 | 14 | 0 |

Server non-test code is almost entirely A/B. Client non-test code is almost entirely C.

## 3. Category A: gym-specific, MUST KEEP

- Gym id `'psycle-london'` (282 tokens): `gyms.config.js`, `db.js` (DDL defaults and migrations at ~L396-685,
  `GYM_DEFAULT_RE`), `server/auth.js`, `DEFAULT_GYM_ID`, URL-state tests, cache-key examples, and most server tests.
  Also persisted in every `gym_id` column, so it can never change without a DB migration.
- `psyclelondon.com` origin/referer headers, `psycle.codexfit.com` v2 base URL (`gyms.config.js`, `providers/codexfit*.js`).
- `dev@psycle.com` mock login (`mock.js`, `server.js` L57, tests `test-codexfit-mock-login.js`, `test-auth-and-proxy.js`).
- `PSYCLE` / `PSYCLE_POLICY` / `PSYCLE_FUTURE_RELEASE_START` test constants (about 190 tokens, in
  `test-booking-window-policy.js`, `test-wake-clock.js`, `test-poller-backoff.js`, `test-regression-psycle.js`,
  `gym-context.test.js`, `gym-brand-fixture.js` and others). These name the gym fixture.
- Comments that correctly describe Psycle policy (Monday-noon window, tier days, scheduler/poller/calendar/lib.js
  history comments). About 300 of the B-classified tokens are really this and need no change.
- Docs link names `psycle_codexfit.md`.
- `test-regression-psycle.js` file name (regression suite for the Psycle gym; keep).

## 4. Category B: app-level, SAFE to rename (about 25-40 real items)

| Item | Where | Note |
|---|---|---|
| Header comment "Psycle PWA server" | `client/src/api.js` L12 | comment only |
| Fallback gym name `'Psycle'` x4 | `client/src/api.js` L422, 558, 768, 826 | actually a latent bug: a gym-less/odd link would label as Psycle; replace with neutral wording, check `api-no-gym.test.js` and `auth-title-copy.test.js` |
| User-facing "ask Psycle to cancel" | `server/poller.js` L397 | should use the row's gym name; text lands in the DB `status` note and notifications; grep tests for the string first |
| ICS download filename `psycle.ics` | `server/server.js` L788 | header only; safe, rename to `sweat.ics` |
| `package.json` names `psycle-pwa`, `psycle-client`, `psycle-server`; description "Psycle Server + PWA Migration" | 3 package.json + 2 lockfiles | npm names only; lockfiles must be regenerated (`npm install --package-lock-only`); check Dockerfile/deploy.sh for workspace names first |
| `server/dev-setup-jab.js`, `warm-instructor-photos.js` comments | 4 tokens | comment-level |
| "Psycle" in `credits.js` L30-32 | comments | correct (website fallback really is Psycle). Keep. |

## 5. Category C: RISKY app-level identifiers

### C1. Persisted client storage (renaming logs users out or loses data)

| Identifier | Uses | Needed for rename |
|---|---|---|
| localStorage `psycleLocalToken` | 7 (main.js, api.js, others) | dual-read shim: read new key, fall back to old, write new, delete old. Without it every user is logged out |
| localStorage `psycleUserId` | 8 | same shim. It prefixes IndexedDB cache keys, so a miss orphans caches |
| localStorage `psycleTheme` | 2, **plus an inline pre-paint script in `client/index.html` L32** | shim in both inline script and JS or the theme flashes |
| `psycleOnboardingComplete`, `psycleOnboardingStep`, `psycleInstallPending`, `psycleInstallDismissed`, `psycleHelperDismissed`, `psycleUpgradeExplainerDismissed`, `psycleDefaultFilters`, `psycleUnified*` (4), `psycleCacheEvents/Meta/Time`, `psycleActiveStudioIds*` | 1-2 each | onboarding flag is the worst: not shimmed means every user sees onboarding again. Caches are disposable (refetch) |
| sessionStorage/other `'psycle'`-prefixed literals (20x `'psycle'`) | various | check each; some are dataset or kind values |
| IndexedDB database name `'psycle-cache'` | `client/src/cache.js` L9 and `timetable.js` (shared DB, versioned) | renaming = a new empty DB. Acceptable only as a deliberate cache reset; the old DB should be deleted via `indexedDB.deleteDatabase`. Both modules must change together |
| Admin SPA `psycleAdminToken` | `server/admin.html` L446 | 1h token; trivial, rename freely |
| Service worker cache names | already migrated to `sweat-cache-*`; sw.js still purges `psycle-cache-*` legacy names | keep the purge code until all clients have updated |
| `manifest.json` | clean (already "Sweat Assistant") | none |
| Cookies | none found | none |
| Env vars | none containing PSYCLE | none |
| DB table/column names | none contain psycle (only the `psycle-london` VALUE, class A) | none |

### C2. Config export/import file format (external, user-held backups)

`server/server.js` L955-1021: JSON keys `psycleSettings`, `psycleStudioPreferences`, `psycleAutoBookings` on
`GET /api/config/export` and `POST /api/config/import`, plus the client import UI. Users hold old files, so the
importer must accept BOTH old and new keys indefinitely; only the exporter can switch. Test:
`server/test-config-export-import.js`.

### C3. Custom DOM events (JS-to-JS, no persistence; coordinated dispatch/listen edit)

`psycle-booking-state-changed`, `psycle-bookings-mutated`, `psycle-data-refreshed`, `psycle-gym-needs-relogin`,
`psycle-layout-updated`, `psycle-logout-triggered`, `psycle-network-fail`, `psycle-network-ok`,
`psycle-offline-snapshot`, `psycle-studio-preferences-mutated`, `psycle-timetable-performance`,
`psycle:calendar-action-complete`, `psycle:gyms-changed`. 13 names, about 35 sites. Safe provided each
dispatcher and all listeners (including tests that dispatch them) change in one commit. The SW does not use them.
A cheap order-independent way: one `events.js` constants module, then rename values.

### C4. CSS classes, ids and custom properties (the bulk: about 4,700 tokens)

- `#psycle-helper-container` x1,014 in styles.css: the app-root scope selector. Defined in `index.html`
  (id) and referenced from CSS and JS. A single id, so a literal find-replace across styles.css, index.html and JS is
  mechanical but must be atomic (HTML+CSS+JS+tests together).
- Component classes: `.psycle-table*` (about 90), `.psycle-btn*` (about 140), `.psycle-modal*`/`.psycle-ovl*`/
  `.psycle-page` (about 150), `.psycle-settings-*`, `.psycle-mobile-*`, `.psycle-tt-*`, `.psycle-gym-*`,
  `.psycle-onb-*`, `.psycle-ms-*`, `.psycle-card-*`, `.psycle-spinner`, `.psycle-select`, etc.
- Ids: `#psycle-timetable-grid`, `#psycle-panel-my-bookings`, `#psycle-app-container`,
  `#psycle-instructor-tooltip`, `#psycle-timetable-rows/filters-container/carousel`, `#psycle-login-*`, others.
- Custom property `--psycle-header-h` (8).
- Also referenced from non-CSS strings: class names built in JS template strings, `querySelector` selectors,
  `classList` toggles (`psycle-scroll-locked`, `psycle-page`, `psycle-offline`, `psycle-tt-compact`), body/`html` state
  classes, and inline `<script>` in `index.html`.
- AGENTS.md documents the important constraint: **this stylesheet relies on `!important` and source order**, so a
  mechanical rename must not reorder rules, and the `.psycle-ovl`/`.psycle-modal` recipe in `modal-nav.js` and
  `DESIGN.md` section 6.2.1 must be updated together.
- No external consumer (SW, manifest, server) depends on these, so there is no persistence risk, only
  atomicity and test risk. Rename must be done with the identical sed over `client/src` and `client/index.html`,
  then a real-browser smoke test (AGENT_PROTOCOL: real Chrome, not jsdom).

## 6. Group-level rename candidates

| # | Group | Tokens | Risk | Needs |
|---|---|---|---|---|
| 1 | Prose/user-facing app copy (B list in section 4), ICS filename | about 10 | Very low | check tests asserting strings |
| 2 | `package.json` names and lockfiles | 7 | Low | regenerate lockfiles; check Docker/deploy |
| 3 | `psycleAdminToken` | 1 | Low | none (admin re-login) |
| 4 | Custom events (C3) | about 35 | Low-medium | single atomic commit, tests that dispatch them |
| 5 | `--psycle-header-h` custom prop | 8 | Low | CSS plus the JS that sets it |
| 6 | Disposable cache keys (`psycleUnified*`, `psycleCache*`, `psycleActiveStudioIds*`) | about 10 | Low-medium | none; cache just refills |
| 7 | CSS component classes and ids (C4, excluding root id) | about 3,700 | Medium (volume, `!important` order, JS selectors) | atomic sed over CSS+HTML+JS+tests; browser smoke |
| 8 | Root scope `#psycle-helper-container` | 1,014 | Medium | same as 7; do last in the CSS pass so a failure is easy to bisect |
| 9 | Config export keys (C2) | 6 | Medium (external files) | importer accepts both forever |
| 10 | IndexedDB `psycle-cache` | 3 | Medium-high | deliberate cache reset plus deleteDatabase of old; cache.js and timetable.js together |
| 11 | Auth/identity storage `psycleLocalToken`, `psycleUserId`, onboarding flags, theme | about 25 | HIGH | dual-read shim in main.js, api.js and the inline script; keep for several releases; otherwise mass logout and re-onboarding |
| 12 | `'psycle-london'` gym id | 282 | DO NOT RENAME | persisted in every DB `gym_id`; it is a gym, not the app |

## 7. Recommended order (lowest risk first)

1. Group 1 and 3: comments, fallback gym-name text, ICS filename, admin token key.
2. Group 2: package names plus lockfile regeneration.
3. Group 5 and 6: header-height property and disposable caches.
4. Group 4: events behind a shared constants module.
5. Groups 7 and 8: CSS/HTML/JS classes and ids in one atomic commit, then real-browser smoke
   (Chrome CDP :9222 or Claude for Chrome), checking mobile bottom-nav, modals (`openPage` full-screen), settings menu,
   timetable table widths (see the AGENTS.md table gotchas).
6. Group 9: export/import with dual-accept.
7. Group 10: IndexedDB bump with explicit cleanup, ideally alongside a service-worker release.
8. Group 11 last (or never): ship the dual-read shim first, rename the write side one or two releases later,
   remove the read fallback much later. The benefit is purely cosmetic; the cost is user logouts if mishandled.
9. Never: group 12.

## 8. Tests that would need updating

Client (vitest): `client/src/ui/modal-nav.test.js` (19 C tokens), `overlap-modal.test.js` (8), `spot-setup.test.js` (4),
`calendar-modal.test.js` (5), `progressive-merge.test.js` (3), `credit-allowance.test.js` (5), `loading-skeleton.test.js`
(2), `gym-mark.test.js` (2), `cards-gym-tags.test.js` (2), `api-no-gym.test.js` (2), `auth-title-copy.test.js` (2),
`network-write-guard.test.js` (2, event names), `timetable-url-sync.test.js` (1). Those that assert the literal class
name or event name or storage key fail on rename.
Server: `test-config-export-import.js` (export keys), `test-poller-backoff.js` (8 C-shaped tokens), `test-reminder-sweep.js`,
`test-schedule-cache.js`, `test-gym-isolation.js`, `test-background-gym-session.js`, `test-calendar-settings-multigym.js`,
`test-auth-and-proxy.js`, `test-retired-endpoint-scan.js` (scans source text; confirm it does not pin names),
`test-notification-*` if poller text changes. `test-no-gym-privilege.js` scans source and may flag new literals.
None of the A-class gym-id tests need edits.
Not covered by `npm test`: the browser smoke layer, which is the only thing that catches a CSS/HTML/JS selector
mismatch. It must be run for groups 7, 8 and 11.

## 9. Caveats

- Counts are token counts from a script; they differ from raw `grep -c` line counts.
- The B/A split for server comments is judged by reading samples, not every line.
- `server/public`, `dist`, fixtures and Documentation were excluded by instruction. `server/public` is a build
  output and will mirror client renames on next build.

## 10. Step 4 results (app-level rename, category B)

Verified first: a real-Chrome capture (CDP) of login, all 6 tabs, 8 Settings panes and /admin in dev mode found no
visible string that calls the APP "Psycle". Every visible hit names the gym ("Psycle London", the "Works with Psycle, ..."
gym list). A repo-wide scan of non-test client/server code for bare `Psycle` found the same: of about 150 hits, all but
the items below are correct gym-policy comments or gym labels. AFTER capture: zero text differences, npm test green
(68/68 server suites, 62 client files / 465 tests), client build OK.

Renamed (batch 1, 1 commit, 5 files):
- `client/src/api.js`: header comment ("Psycle PWA server" -> "Sweat Assistant server"); the four `|| 'Psycle'` gym-name
  fallbacks -> `'Gym'` (a gym-less link no longer labels itself Psycle).
- `client/src/ui/timetable.js`: module-local `psycleEvents` -> `timetableEvents` (21 refs, not exported).
- `server/poller.js`: cutoff note "ask Psycle to cancel" now names the row's gym.
- `server/server.js`: ICS download filename `psycle.ics` -> `sweat.ics`.
- `package.json`: description only.

Kept, uncertain: `window.__psycleTimetablePerformance` (global read by browser checks); npm package names
`psycle-pwa/-client/-server` and the `psycle.db` path in Dockerfile/backup script (deploy and lockfile coupling);
`copy.js` "Supports Psycle, ..." (names gyms, correct); Docs/AGENTS.md title "Psycle PWA".

Remaining category C for a later step (unchanged, all persisted or atomic-rename work): CSS classes/ids/`--psycle-*`
(atomic sed over CSS+HTML+JS+tests); custom DOM events (shared constants module); `psycleAdminToken`; disposable
caches `psycleUnified*`/`psycleCache*`; IndexedDB `psycle-cache` (deliberate reset plus deleteDatabase); config export
keys `psycle*` (importer must accept old and new forever). Shim plan for identity storage (`psycleLocalToken`,
`psycleUserId`, `psycleTheme` incl. the inline script in `client/index.html`, onboarding flags): ship a dual-read
(new key, fall back to old, write new, delete old) first, rename the writes one or two releases later, drop the
read fallback much later; otherwise mass logout and re-onboarding.

## 11. Step 5 results (app-level `psycle-` -> `sa-` / `sweat`)

**Phase A (persisted identifiers, commit `0909a12`).** localStorage keys `psycle*` -> `sweat*` (token, user id, theme,
onboarding, install flags, helper/upgrade-explainer dismissals, default filters, unified caches, admin token), IndexedDB
`psycle-cache` -> `sweat-cache`, and 13 custom DOM events -> `sweat-*` / `sweat:*`. `client/src/storage-migrate.js` is the
shim: a one-time, marker-guarded copy (new key wins, old key kept for one release), imported FIRST by `api.js` and
`main.js` so it runs before the token is read at module load; `removeStored()` clears new and legacy twins on logout so a
signed-out device never keeps a live token; `cache.js openDB()` copies the old database's rows once (keys renamed too) and
leaves it in place; `index.html` pre-paint script falls back to `psycleTheme`. `sw.js` needed no change: its activate
handler is a whitelist, so every legacy cache name is already purged. 12 vitest cases (old-only, new-only, both, none,
suffixed keys, run-once, blocked storage, removal, key maps).
Real Chrome: a device seeded with old keys plus an old IndexedDB loaded the new build still signed in, theme dark, onboarding
and filters copied, old IDB rows present in `sweat-cache`, token key survives a second load, `setToken(null)` leaves neither name.

**Phase B (CSS/DOM, commits batch 1..6 + rest).** About 4,200 tokens across 36 files, by first-word family: 1 root scope id
`#psycle-helper-container` + `--psycle-header-h`; 2 modal/overlay/page/booking/setup/debug; 3 table/timetable/filters/tooltips;
4 onboarding/auth; 5 settings/gym/multiselect; 6 mobile/nav/shell/cards; rest = remainder. One token map, applied across
styles.css, index.html, client/src (tests included), AGENTS.md and DESIGN.md, no rule reordered. `data-psycle-nav-inert`
-> `data-sa-nav-inert`. Collision check before starting: no existing `sa-` name (only a test email); existing `sweat-*`
classes (`sweat-filter-rail`, `sweat-search-*`) are untouched.
Verification per batch: client vitest, then a real-Chrome (CDP, one tab) run of 101 views (6 tabs, 8 Settings panes, 8
modals/overlays, login, 3 onboarding steps, admin login/list/detail; light+dark; 1280 and 390; date and Math.random frozen,
transitions off). Computed style of every non-SVG-child element plus its box compared with two untouched baselines:
**0 diffs** (views that flaked once, about 1-5 per run, all matched a baseline exactly on re-capture; SVG logo races are the
baseline noise). Pixel residual <= baseline noise. No `@keyframes` missing. Harness gotchas learned: computed-style
enumeration order of custom properties is random (sort them), and the credits tab renders the timetable for a gym without
credit purchase.
Final: `npm test` 68/68 server suites + 63 client files / 477 tests, client build OK.

**Kept (decided by meaning).** Gym id `psycle-london`, `gyms.config.js`, `providers/codexfit*.js`, `mock.js`,
`psyclelondon.com`, `dev@psycle.com`, `--gym-psycle` / `psycle-gym-mark-psycle-london` id segment, `/gyms/psycle-london*` assets.
Calendar event UIDs `UID:psycle-${userId}-...` in `server/calendar.js` (subscribers' calendars key on them; renaming
duplicates every event). Package names `psycle-client/-server`, container `psycle-app-dev`, doc names `C2-psycle-api-v2.md`.
**Uncertain, not renamed:** localStorage `psycle-helper-favorites` (comment says it is shared with the Chrome extension),
`window.__psycleTimetablePerformance` (read by browser checks), arbitrary test strings (`psycle-value`, `psycle-week2`,
`my-secure-psycle-password-123!`), mock.js comment. Mixed prefixes remain by design: older `sweat-*` classes next to the
new `sa-*`. Documentation outside AGENTS.md/DESIGN.md (workstreams, QA runs, archive) still names old tokens; historical.
Not done from earlier plans: config export/import keys `psycleSettings` etc. (server importer must accept old and new
forever; untouched).

**Shim removal plan.** Release N (this): shim live, old keys kept. Release N+1 (after one active-user cycle, ~30 days, the
JWT lifetime): stop copying, delete `storage-migrate.js` and its two import lines, the `psycleTheme` fallback in
`index.html`, and run `indexedDB.deleteDatabase('psycle-cache')` plus a sweep removing any remaining `psycle*` keys once.
Check first that no support path still seeds old keys (`server/dev-setup-jab.js` already prints `sweat*`).

## 12. Step 6 results (neutral `app` prefix, shim deleted, app name from config)

**Master merge (`210124c`).** Master (favourites F-12, share-my-bookings F-3, perf/logging) overlapped 12 of our files
(styles.css, index.html, main.js, timetable.js, settings.js, bookings.js, filter-rail.js, api.js, admin.html, poller.js,
server.js, AGENTS.md). Dry-run merge gave 12 conflict hunks in 4 files (index.html 4, main.js 1, styles.css 5,
timetable.js 2); every one was our renamed copy of lines master had rewritten, so master's side was kept and `psycle-`
re-applied (about 140 new tokens, `psycleEvents`). Verified afterwards: no master-added CSS line missing, no class with a
base rule now rule-less while still referenced, JS differs from master only by the intended renames. Favourites click-through
in Chrome: heart toggles bookmarked/unbookmarked on a row, the Settings > Favourites pane lists the class, revert works.
New favourites views (heart, pane with an item, share drawer) were added to the before/after harness.

**Batch 7: `sa-`/`sweat-` -> `app-` (about 5,050 replacements, 70 files).** CSS/DOM classes, ids, `--sa-header-h`,
`data-app-nav-inert`, events (`app-network-fail`, `app:gyms-changed`...), storage keys (`appLocalToken`, `appTheme`...),
`history.state` keys, IndexedDB `app-cache`, service-worker caches (`app-cache-<stamp>`, `app-images-v2`,
`app-config-v1`). Collision check first (grep of `app-`, `--app-`, `app[A-Z]`, ids): the only real clash was
`sa-search-box` vs the newer `sweat-search-box` (both would become `app-search-box`), so the older bookings search field is
now `app-search-field`; `sa-app-container` collapses to `app-container` (not `app-app-container`). Pre-existing
`appName/appConfig/appCopy` JS identifiers do not clash with any string key. The migration shim is gone:
`storage-migrate.js` + tests, its imports (api.js, main.js, settings.js, cache.js), the `psycleTheme` fallback in index.html,
the legacy-name notes in sw.js/vite.config.js/AGENTS.md. `psycle-helper-favorites` -> `app-helper-favorites`,
`window.__psycleTimetablePerformance` -> `__appTimetablePerformance` (only consumer was timetable.js). Server: calendar
UID prefix `psycle-<user>-` -> `app-<user>-` (+ test-calendar-prefs), config export/import no longer emits or reads the
`psycle*` keys (new `autoBookings`; the flat legacy import branches are removed, tests updated), package names `app-pwa/-client/-server`.

**Batch 8: app name from config.** Literal 'Sweat Assistant' in code: 23 lines in 6 files before (index.html, manifest.json,
sw.js, admin.html, server.js, app.config.json), 0 after; 73 occurrences including comments, 0 after (comments reworded).
`app.config.json` deleted (and its Dockerfile COPYs). The default exists only in `server/config.js`. Mechanism: the static
files carry `__APP_NAME__`; `server.js sendTemplated` substitutes the configured name per request (escaped for HTML, JSON or
JS), the `template-app-name` Vite plugin does the same in dev, `vite build` leaves the placeholder; client `config.js` takes
the already-templated `document.title`, then `/api/config`; the generic push test now comes from
`notifications.js sendGenericTest` (title `<name>: Test Notification`). Tests: `test-app-name-config.js` (APP_NAME='Test Gym App'
and an awkward name: /api/config, index, manifest, sw.js, admin, calendar PRODID/X-WR-CALNAME, push payload; none contain
'Sweat') and `test-no-hardcoded-app-name.js` (source scan outside config.js). Chrome with APP_NAME overridden and default:
title, apple title meta, login, onboarding, Settings > About, manifest, admin all show the configured name; with the
override no 'Sweat' anywhere in the DOM.

**Verification.** `npm test`: 78/78 server suites, 69 client files / 515 tests; client build OK. Real Chrome (CDP, one tab),
113 views (6 tabs, 9 Settings panes incl. Favourites, modals incl. booking/filters/notification prefs/password/spot maps/
profile explorer/add gym/re-auth/share drawer, login, 3 onboarding steps, favourites heart + pane, admin; light/dark; 1280/390)
against a baseline of the merged tree: computed styles of every non-SVG-child element and their boxes identical (flaky views
re-captured until they matched a baseline exactly); admin views are checked by diff instead (admin.html changed only by the
placeholder and the token key, and its localStorage lives on a separate origin so the harness cannot reset it).

**Hardcoded Psycle special cases still in core (listed, not refactored).** (1) `dev@psycle.com` mock bypass: auth.js,
poller.js (2), scheduler.js, dev-setup-jab.js, plus `DEV_EMAIL` in providers/codexfit.js. (2) `server/config.js` default
`publicHost` `psycle.wingfield.tech` and `push.js` default VAPID mailto `admin@psycle.wingfield.tech`. (3) `client/src/ui/credits.js`
fallback website URL and checkout copy that assume Psycle's storefront. (4) `client/src/copy.js` welcome line "Works with
Psycle, Barry's, SoulCycle, Aarmy, JAB...". (5) Infra naming: `DB_PATH=/data/psycle.db` in the Dockerfile, `psycleapp*`
remote dirs in deploy.sh, `psycle-sqlite` backup paths, container `psycle-app-dev`: renaming touches the live prod volume,
so not done. (6) `DEFAULT_GYM_ID = 'psycle-london'` fallbacks (gyms.config, by design) and test names such as
`test-regression-psycle.js` (gym black-box suite).
