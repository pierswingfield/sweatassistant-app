# U4-19 — Clean URLs, browser history and timetable deep links

Status: **Phases 1-8 DONE on branches `worktree-enh-5-10-timetable` (1-3) and `followups-2026-10-06` (4-8), 2026-10-06, not deployed. `q` is parsed-only; iOS standalone UNVERIFIED; desktop modals unchanged (see phase 6).** Plan approved 2026-10-05. Phase 7's `notificationclick` -> `NAVIGATE {path}` part landed early with phase 3 (the old `pathname === '/'` match would have broken on clean paths); `returnTo` landed in phase 7 below.
Evidence (phases 1-3): vitest `url-state.test.js` (round-trips, hostile input), `server/test-spa-fallback.js`, `npm test` green on Node 20, and a real-Chrome CDP run (22/22) against a production build: refresh on each path, back/forward across tabs and settings sections, legacy `#hash` redirect, gym-pane deep link, with SW/CacheStorage/IndexedDB cleared first.
Implementation notes: `client/src/url-state.js` (pure), `client/src/router.js` (`navigate`, `initRouter`, `migrateLegacyHash`; `commitFilterChange` deferred to phase 4). Server `SPA_PATH_RE` allowlist in `server.js`; unknown `/api/*` is JSON 404 in every mode; other unmatched production paths are plain 404. `PUBLIC_DIR` env overrides the built-client dir (used by the test). Onboarding `finish()` no longer rewrites the URL, so a deep link survives it. `home-routing.js resolveInitialTab` is now unused by `main.js` (kept, still tested). `/credits` while the Credits tab is debug-gated is replaced by `/timetable`. Unknown client paths replace to `/`.
Original status line: PLAN ONLY (2026-10-05). Parent: [U4](U4-ux-improvements.md). Feeds [H](H-home-page.md) (homepage widgets link to filtered timetables) and the per-gym instructor filter enhancement.

## Today (verified in code)
- Tabs live in the **hash** (`main.js` `switchTab` does `replaceState('#tab')`; `VALID_TABS`; a `popstate` handler re-reads the hash). Back/forward therefore never walk tab/day/filter history.
- `modal-nav.js` already pushes `history.pushState({sweatNavId})` (no URL change) per mobile modal, with a capture-phase `popstate` that sets `e.sweatNavHandled`. Reuse it; do not fight it.
- Filter state is module-level in `timetable.js` (`selectedGyms/Locations/Instructors/EventTypes`, `showBookmarksOnly`, `selectedTimetableDate`). Saved defaults: `localStorage[accountScopedKey('psycleUnifiedDefaultFilters')]`, loaded by `loadStoredFilters()`, written only by the save-defaults button.
- Server: production-only `app.get('*')` serves `index.html` (so it would also return HTML for unknown `/api/*`); `/admin` is its own route; `.ics` is `/api/calendar/:token.ics`. Vite dev has no SPA fallback issue (it falls back by default) but proxies only `/api`.
- `sw.js`: navigation = network-first, offline fallback `/index.html`; push click matches `pathname === '/'` and posts `{hash:'#my-bookings'}`. `manifest.json` `start_url: "/"`.

## URL schema
| Path | Tab | Notes |
|---|---|---|
| `/` | home | **Decided 2026-10-05: `/` is Home** (the earlier "stays timetable until H ships" decision is withdrawn) |
| `/timetable` | class-timetable | params below |
| `/bookings` `/auto-book` `/credits` | my-bookings, auto-book, buy-credits | no params |
| `/settings`, `/settings/:section` | settings (+ `about`, per-gym entries) | section = existing sidebar id, `gym-<gymId>` |
| `/admin`, `/api/*` | untouched | server routes win |

Timetable params (all optional; repeated values comma-separated; absent = "use saved defaults"):
| Param | Example | Meaning |
|---|---|---|
| `day` | `2026-10-07` | selected day, gym-local ISO date (via `lib.js` zone helpers) |
| `gym` | `jab,psycle-london` | gym ids (config ids) |
| `loc` | `jab:12,psycle-london:3` | locations, **always `gymId:id`** (ids are strings) |
| `type` | `psycle-london:ride` | workouts / event types, `gymId:id` |
| `instructor` | `psycle-london:123` | **`gymId:instructorId`** (compatible with the per-gym enhancement; bare ids rejected) |
| `fav` | `1` | favourites only |
| `q` | `boxing` | search text (reserved; parsed and round-tripped now, UI later) |
| `f` | `all` | present with no other filter params = explicit "no filters", distinct from "use defaults" |

**Decisions (2026-10-05):** the root path `/` is Home (the homepage shell already exists, see [H](H-home-page.md)); the search query param is `q` (see the timetable search spec; state lives in `client/src/ui/timetable-search-state.js`, URL wiring not yet implemented).

Homepage link: `buildTimetableUrl({ gym:['psycle-london'], instructor:['psycle-london:123'], day })` returns a string; widgets render `<a href>` and a click handler calls `navigate(url)` (SPA push, no reload). Never hand-concatenate URLs.

## Module: `client/src/url-state.js` (pure, no DOM)
- `parseLocation(pathname, search) -> { tab, section, timetable: {day, gyms, locations, types, instructors, fav, q, explicit} }` (lenient: drops malformed tokens, validates tab and ISO date, caps list lengths, de-dupes; never throws).
- `serializeState(state) -> '/timetable?...'` (stable param order, omits defaults, `encodeURIComponent` values, no personal data).
- `isDeepLink(parsed)`; `legacyHashToPath('#my-bookings')`; `sameState(a,b)` for push-vs-replace.
- Tests `url-state.test.js` (vitest): round-trip property over generated states, malformed/hostile input, string ids, `gym:id` splitting with colons in ids, legacy hashes, stable order.
- Thin impure layer `client/src/router.js`: `navigate(url,{replace})`, `initRouter(handlers)`, `commitFilterChange()` (debounced ~1000 ms: rapid chip toggles coalesce into ONE `pushState`, first change of a burst pushes, later ones in the window `replaceState`), single `popstate` listener that applies state to tabs and timetable then ignores events flagged `sweatNavHandled` by modal-nav.

## Deep-link behaviour
- On entry with timetable params: apply them as a **temporary overlay** (in-memory only); `loadStoredFilters()` still reads saved defaults, and the save-defaults button and `localStorage` writes are guarded so an overlay is never persisted (guard asserted by test).
- Banner above the list: "Filtered: Johan, Psycle  Clear". Labels resolve from metadata after load (id fallback while loading; unknown ids shown as "unavailable" and dropped from the query, never fatal). **Clear** = `replace` URL with params stripped and reload the SAVED set (not wiped). Manually editing filters afterwards pushes a normal entry and keeps the banner off.
- Linked gym check: a `gym=` the user has not linked is ignored with a toast, not an error.

## Phases
| # | Phase | Risk | Test strategy | Est. |
|---|---|---|---|---|
| 1 | `url-state.js` + tests; `router.js` skeleton | Low | vitest (pure) | 3 h |
| 2 | Server SPA fallback: allowlist of app paths, keep `/admin`, `/api/*` (unknown -> JSON 404, not HTML), `/gyms`, `/icons`, `/sw.js`, `/manifest.json`; Vite dev `appType: 'spa'` confirm; `/` and path routes template `index.html`. Add `<base>`-free absolute asset URLs check (built asset paths must be `/assets/...`, else nested paths like `/settings/gym-jab` break) | **High** (a mis-ordered `*` swallows APIs/.ics) | new `server/test-spa-fallback.js` (supertest style, like other suites): each path class + `.ics` + 404 JSON; `npm test` | 3 h |
| 3 | Tabs onto paths: replace hash `switchTab`/`popstate`; legacy `#tab` and `#about` -> `replaceState` to path on boot (old links, old push payloads); push entry per tab change; settings sections | Med | vitest for mapping; browser: back/forward across tabs, refresh on each path | 4 h |
| 4 | Timetable state sync: apply on load, push on day change, debounced push on filter-set change, popstate restores day+filters and re-renders without refetch loops (set-from-URL must not re-push) | **High** (render/popstate feedback loops, per-gym caches) | vitest on router coalescing with fake timers; browser matrix: chip bursts, day taps, back x3, forward | 6 h |
| 5 | Deep-link overlay + banner + Clear-to-saved, defaults write-guard, i18n copy in `copy.js`, a11y (banner `role=status`, Clear focusable) | Med | vitest (guard, label resolve); browser: link in, Clear, Save-defaults disabled/safe, saved set intact | 4 h |
| 6 | Modals in history: confirm `modal-nav.js` entries carry the current URL (they pass no URL, so they inherit it; fine) and desktop modals not yet wired push too; Back closes top modal before changing route | Med | existing `modal-nav.test.js` + browser | 3 h |
| 7 | SW + manifest + auth return-to: navigation fallback already shell-based; stop matching `pathname === '/'` in `notificationclick` (use `NAVIGATE {path}`, open `/bookings`); `scope`/`start_url` stay `/`; login screen stores `returnTo` (validated same-origin path, sessionStorage) and restores after login/onboarding | **High** (stale SW, open redirect) | unit-test `returnTo` validator; browser with SW cache cleared (3 caches, see prod-deploy-cache-gotcha) | 4 h |
| 8 | Docs (`DESIGN`/`TESTING`/H link contract), browser smoke on dev twin, iOS standalone check | Low | LIVE check on `sweat-dev` | 2 h |

Total about 29 h (~4 working days) plus ~0.5 day dev-twin soak. Land phases 1-3 first (shippable alone), then 4-5.

## Files affected
New: `client/src/url-state.js`, `url-state.test.js`, `router.js`, `server/test-spa-fallback.js`. Edit: `client/src/main.js`, `ui/timetable.js`, `ui/filter-rail.js`, `ui/settings.js` (sections), `ui/modal-nav.js` (verify only), `copy.js`, `styles.css` (banner), `client/public/sw.js`, `server/server.js`, `client/vite.config.js` (verify), `Documentation/TESTING.md`.

## Open risks
- **iOS standalone PWA**: no URL bar, no reliable back gesture inside standalone; history still works for the swipe-back gesture but a deep link opened from elsewhere opens Safari, not the installed app. Needs a real-device check; do not promise "link opens the app".
- **SW cache**: a cached `index.html` for `/timetable?...` keyed by full URL grows per filter combination; cache navigations under the shell key (`ignoreSearch`) and keep build-stamped names (C7-2).
- **Auth return-to**: only same-origin relative paths; strip `//` and scheme; never put credentials or tokens in the URL.
- **Cloudflare**: confirm no page rule/cache or Access policy treats non-root paths differently on `sweat*.wingfield.tech`.
- **Hash links in the wild**: old bookmarks and push payloads; keep the legacy redirect permanently.
- **Merged cache scoping**: URL gym ids must be validated against the linked set; instructor tokens without `gymId:` are rejected.
- **popstate ordering** with `modal-nav.js` (capture listener) must be preserved.

## Open decision for the user
None. Resolved 2026-10-05: `/` is Home. URL filters are a temporary overlay with a Clear banner and never overwrite saved defaults.

## Evidence, phases 4-8 (2026-10-06, local production build served by the local server on :3077, isolated Chrome 154 via raw CDP on :9333, SW + CacheStorage + IndexedDB cleared before every run, mock gyms only)
- **4 (state sync)**: `ui/timetable-url-sync.js` (pure) + `router.commitFilterChange/commitNow/replaceCurrent`; `timetable.js syncUrlFromState` runs from `renderTimetableGrid` after the day is validated, so set-from-URL cannot re-push (it consumes a one-shot `urlReplaceOnce`). State equal to the SAVED defaults emits no filter params; empty-under-non-empty-saved emits `f=all`; the default day is omitted. Browser: 2 day taps = 2 entries; a 3-chip burst = ONE entry (history delta 3 for 2 days + 1 burst); a later burst after the quiet window = a new entry; back x3 and forward x2 restored day AND ticked chips each time with no extra entries or console errors. Same-tab popstate repaints via `restoreTimetableFromUrl` (no refetch, no tab churn). Vitest: `router.test.js` (fake timers), `timetable-url-sync.test.js`.
- **Mapping decisions**: state holds bare location ids and discipline LABELS, the URL carries `gym:id` and `gym:slug`. A label is emitted under the first gym that has it (prefers a selected gym) and parsed back by slug against any linked gym's workouts. Lossy only in that the gym part of a `type` token is a validity hint, not a filter. `q` is parsed and round-tripped by `url-state.js` but NOT wired to the search UI (search runs in its own filter scope; wiring would mean snapshotting that scope from a URL); URL sync is suspended while search scope is active.
- **5 (overlay)**: banner `#psycle-url-overlay-banner` (`role=status`, `aria-live=polite`, native focusable Clear button; copy in `COPY.timetable.overlay*`). Clear = restore the SAVED set, strip filter params via replace, focus moves to the grid. Save-defaults goes through `guardedSaveDefaults` and is refused with a toast while an overlay is active; asserted by unit test plus a source scan that nothing else writes `psycleUnifiedDefaultFilters`. Browser: deep link with `ghostgym` (toast shown, ignored), `psycle-london:999` (dropped, banner says "1 unavailable"), save while overlay refused and the stored set byte-identical, Clear restored the saved location, a manual edit afterwards pushed a normal entry with no banner. A reload of a URL that carries params is a deep link and shows the banner by design; so does Back/Forward onto a filtered entry. Contrast (banner text and Clear): 14.4-16.8:1 in light and dark, desktop and 390px.
- **6 (modals)**: all 14 modal call sites already go through `modal-nav.openPage`; its `pushState({sweatNavId})` passes no URL so the entry inherits `/timetable?...`. Browser at 390px: opening a booking modal added one entry, URL unchanged, Back closed it with the URL and banner intact. Desktop (>768px) modals deliberately still add no history entry (that is `modal-nav`'s existing contract; changing it was not asked for). Existing `modal-nav.test.js` green.
- **7 (SW + returnTo)**: `router.safeReturnTo` (rejects `//`, schemes, backslashes, encoded variants, control chars, `/api` and `/admin`; 28 unit cases) with sessionStorage stash/take, stashed on any logged-out boot (onboarding never calls `showLogin`) and on `showLogin`; restored only when the URL was reset to the bare root. Browser: logged out at `/bookings`, URL reset to `/`, login via onboarding, finished onboarding -> landed on `/bookings`. SW: navigations cached under the single shell key, `/admin` navigations no longer overwrite it (was a latent bug), offline fallback uses `ignoreSearch`; cache names still build-stamped. Notification click: `NAVIGATE {path}` handled (message simulated via CDP; the SW `notificationclick` event itself was NOT dispatched, UNVERIFIED), legacy `#auto-book` redirects to `/auto-book`.
- **8**: TESTING.md and the H link contract updated; `url-state.buildTimetableUrl` added (it was specified but never built).
- **UNVERIFIED**: iOS standalone PWA (back gesture, link-opens-app), a real push notification click, Cloudflare behaviour on non-root paths, the dev twin (deploy is the coordinator's).
- **Found, not fixed**: `server.js` caches the templated `index.html` for the process lifetime, so a rebuilt client is not served until the server restarts (harmless in prod where a deploy restarts it; cost a confusing hour locally).
