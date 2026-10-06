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
