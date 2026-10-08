# 5-10 enhancements session (archived handoff)

> **CLOSED and archived 2026-10-08 by user confirmation:** the session follow-ups and PWA checks are considered complete. The checklist below is historical and superseded; its unchecked boxes are not current backlog. The separate U4-19 `q` URL-to-search wiring remains tracked in the active U4-19 document. This closure is user-confirmed, not a new verification run.

Session log for the batch of bug fixes and enhancements started 2026-10-05 and carried through 2026-10-06. Work happened in two places and this doc merges both:

- **Worktree** branch `worktree-enh-5-10-timetable` (cut from local `modular` at `49cb376`): committed, not pushed, not deployed.
- **Main checkout** on `modular`: **uncommitted** working-tree changes by another agent (the antigravity / main-agent UI work). Dev twin (`sweat-dev.wingfield.tech`) was deployed several times from there with `deploy.sh` (dev only, never prod).

Working rules the user set: one dev subagent at a time (Sonnet), subagents report under 120 words as (1) root cause, (2) files, (3) pass/fail; Gemini offload (`flash`) for locating code; real-browser verification via Chrome CDP `127.0.0.1:9222` (one tab); stop after each enhancement with a 1-2 sentence test instruction for sweat-dev.

Test environment gotcha: the local default Node (v26) cannot load `better-sqlite3`. Run tests with **Node 20 via nvm** (what the Dockerfile and prod use).

## Status of every item

Where: **W** = committed on the worktree branch, **M** = uncommitted in the main checkout.

| # | Item | Where | Status | Notes |
|---|------|-------|--------|-------|
| 0 | Gym settings: Preferred spot maps directly after Connection | M | Done, verified in browser | `client/src/ui/gym-settings-section.js` |
| 1 | Bug: mobile filter drawer "Workouts" section empty when expanded | M | Done, verified in browser by user | Options back-filled from loaded events' `discipline` when metadata is empty. `workout-options.js` (+test), `timetable.js`. |
| 2 | Bug: quick-book overlap/confirm loop | M | Done, verified in browser by user | Overlap modal once per attempt; acknowledging continues straight through (also through first-time setup), no second confirm tap; busy guard. `quickbook-flow.js` (+test), `timetable.js`. |
| 3 | Per-studio row-group selector flag | M | Done, user confirmed on sweat-dev | Flag in `server/gyms.config.js` (`spotMap.rowGroupStudios`, ids or name pattern; default off; Psycle = `^ride`). Flows via `providers/spot-map.js` to `studio.rowGroups`. UI decision in `spotmap.js` (`studioHasRowGroups`, `rowSelectorVisible`). Editors drop stored rows on save for non-flag studios. |
| 4 | U4-19 URL routing | W + followups branch | **Phases 1-8 done** (1-3 `eb6f5f5`; 4-8 `9b9dd9d`, `d586cf3` on `followups-2026-10-06`, 2026-10-06; not deployed). Search `q` wired and locally browser-verified 2026-10-08; iOS standalone UNVERIFIED | Clean paths, SPA allowlist fallback, legacy hash migration. Plan: `U4-19-url-routing-and-deep-links.md`. |
| 5 | Timetable keyword search | M | Built and iterated, deployed to dev | See "Decisions made". |
| 6 | Instructor filters per gym | M | Built, browser-verified, deployed to dev, user says it works | `gymId:id` tokens in `instructor-filter.js` (+test). Legacy bare ids migrate on read. |
| 7 | Filter drawer tap latency and deselect lag | M | Done, browser-verified (4.5 ms select / 3.2 ms deselect, from ~800 ms) | `countMatchingEventsQuick()`, frame-0 `syncFilterSheetState()`, 100 ms debounced grid render flushed on close. `timetable.js`, `filter-rail.js`. |
| 8 | Discipline: Pilates vs Reformer vs Lagree | M | Done, unit-tested (307 client tests) and browser-verified | `passesDisciplineFilter()`: Pilates and Reformer equivalent, Lagree distinct. `cards.js`, `copy.js`, `timetable.js`. |
| 9 | Filter drawer equal 3-column gym grid | M | Done, browser-verified (114 px each) | `styles.css`. |
| 10 | Settings "Your Gyms" mobile row layout and drilldown | M | Done, browser-verified on sweat-dev | Name text removed (accessible on logo); 3-row grid; row click drills into gym pane; Back returns to Your Gyms. `settings.js`, `styles.css`. |
| 11 | Gym-specific pane header and inline connection row | M | Done, browser-verified on sweat-dev | Name heading removed; Connected badge aligned with logo; `.psycle-gym-conn-inline-row`. `gym-settings-section.js`, `styles.css`. |
| 12 | Filter rail chip icons, whitespace, sheet animation, drag-to-dismiss | M | Done, browser-verified | `pin`/`user` icons, tighter spacing, slide + overlay fade, `wireDragToDismiss` (>70 px). `filter-rail.js`, `cards.js`, `styles.css`. |
| 12a | Instructor chip per-gym counts ("All" when none picked) | M | Done, verified in Chrome mobile viewport; dark mode read not screenshotted | Pure `summariseInstructorsByGym` in `instructor-filter.js` (+test), rendered in `filter-rail.js`. |
| 12b | Bug: iOS filter chip row draggable vertically | M | Fixed in code; real-iOS behaviour UNVERIFIED | `.fr-rail`: `overflow-y: hidden; overscroll-behavior-x: contain; touch-action: pan-x pan-y`. CDP emulation: vertical drag leaves `scrollTop` 0. |
| Q1 | Progressive timetable load (U4-7 + U4-2) | W | **Done** (`27f3181`) | Render on the first gym to respond (grace 0); header gym chips are per-gym loading indicators. |
| Q2 | Mobile gym quick-selector in filter bar | W | **Done** (`66f5195`), browser-verified mobile viewport light and dark | Pure logic `client/src/ui/gym-quick-select.js` (+tests), rail in `filter-rail.js`, state in `timetable.js`. Never writes saved defaults. |
| Q3 | Mobile scroll-collapse (date strip and location chip) | W | **Done** (`de8aebc`), browser-verified mobile light and dark, desktop unchanged | Pure hysteresis `scroll-collapse.js` (+tests), one `psycle-tt-compact` class toggled in `main.js initHeaderAutoHide`, chip faces in `filter-rail.js`, copy `filters.locationsCompact`, CSS block at end of `styles.css`. Mobile scroller is the DOCUMENT; layout-jump guard keeps scrollHeight constant (day cells shrink 16 px while sticky block gains 16 px margin-bottom). |

## Decisions made

- Row-group flag: config in `gyms.config.js` (not admin UI). Admin-managed gym onboarding/config is logged as **F-16** in `F-future-features.md`.
- URLs: **clean paths**, state = day + filters + search `q`; push history on tab/day/filter-set (merge rapid toggles ~1 s), modals push; deep-link banner with Clear returning to saved defaults, link filters never overwrite saved defaults; `/` stays the timetable until the F-10 homepage. Plan reviewed enough to build phases 1-3; remaining open decisions live in the U4-19 doc.
- Search design: hybrid. Autocomplete grouped by type (instructors per gym, classes, locations, gyms, workouts) with counts; picking applies to the search scope; Enter shows a flat day-grouped list of all matching upcoming classes across loaded weeks using the normal row builder. Words ANDed across fields. Mobile: search icon in the filter bar that expands. Search has **its own filter scope**: entering search snapshots filters and starts empty, Clear restores the snapshot, nothing from search is saved to defaults (`timetable-search-state.js`).
- Search speed fix: search re-renders use the `'search'` reason, so they no longer wait on the auto-book queue and studio-prefs calls (865 ms to 14 ms under injected latency).
- Instructor filter semantics: a gym with at least one selected instructor shows only those instructors' classes; a gym with none selected is unrestricted. Never matched across gyms.
- Discipline: Pilates and Reformer filter-equivalent; Lagree isolated (Aarmy labels classes "Pilates"; Psycle treats Reformer and Lagree as distinct).

## Commit summaries

### A. Worktree commits (branch `worktree-enh-5-10-timetable`, merged into `modular` 2026-10-06)

```text
27f3181 feat(timetable): progressive multi-gym load (U4-7) and gym chip loading indicators (U4-2)
66f5195 feat(timetable): mobile gym quick-selector in filter rail (5-10 enh 2)
de8aebc feat(timetable): mobile scroll-collapse of date strip and location chip (5-10 enh 3)
eb6f5f5 feat(routing): clean URL paths, SPA allowlist fallback, legacy hash migration (U4-19 phases 1-3)
37b4e7c docs(5-10): handoff section with outstanding work and test checklist
```

Note: the message of `27f3181` wrongly says "4s grace". Actual behaviour: render on the first gym to respond, grace 0. Fix the wording if squashing.

### B. Main-checkout changes (committed 2026-10-06 as `4ad6b4f` code + `06b38fd` docs)

Proposed message (do not commit until the main agent is done):

```text
ui: optimize filter drawer latency, refine gym settings layout, and balance disciplines

- Filter drawer tap optimization: in-memory countMatchingEventsQuick(), frame-0
  syncFilterSheetState(), 100ms debounced grid render flushed on close
  (~800ms to 4.5ms select / 3.2ms deselect, no dropped taps).
- Discipline: COPY.disciplines.lagree; /pilates/ labelled Pilates (reformer token),
  /lagree/ distinct; passesDisciplineFilter() equates Pilates and Reformer,
  isolates Lagree; cards.test.js coverage (307 tests).
- Filter drawer gym grid: repeat(3, minmax(0, 1fr)), zero min-width, contained
  SVG/img (114px each).
- "Your Gyms": drop redundant name text (kept as aria/alt), 3-row mobile grid,
  row click drills into gym pane, nav history so Back returns to Your Gyms.
- Gym pane: remove heading/eyebrow, align Connected badge with logo, inline
  email + actions row.
- Filter rail: pin/user icons, tighter whitespace, slide-up animation,
  drag-to-dismiss.
```

Files covered:

```text
Documentation/Workstreams/5-10-enhancements.md
client/src/copy.js
client/src/styles.css
client/src/ui/cards.js
client/src/ui/cards.test.js
client/src/ui/filter-rail.js
client/src/ui/gym-settings-section.js
client/src/ui/settings.js
client/src/ui/timetable.js
```

(The main copy also lists work from items 0-3, 5, 6 as uncommitted in the same working tree, e.g. `workout-options.js`, `quickbook-flow.js`, `instructor-filter.js`, `spotmap.js`, `gyms.config.js`, `api.js`, `server/mock.js`, `server/test-rate-limit-reads.js`, plus untracked Home-widget files from another session. Review `git status` in the main checkout before committing.)

### B detail (condensed)

1. **Filter drawer latency.** Cause: `buildFilterRailCtx` ran `rerender()` / `renderTimetableGrid('filter')` synchronously per tap, rebuilding DOM under the thumb (slow, and dropped clicks). Fix: `countMatchingEventsQuick()` (<0.1 ms loop over `psycleEvents`); `isFilterSheetOpen()` and `syncFilterSheetState(ctx)` exported from `filter-rail.js`; while open, `toggle()/clear()/clearAll()` update state, `ctx.resultCount` and sheet UI in frame 0; heavy render debounced 100 ms (`scheduleDeferredFilterRender()`), flushed in `closeSheet()` via `flushDeferredFilterRender()`.
2. **Disciplines.** `copy.js` adds `lagree`; `cards.js getDiscipline()` maps `/pilates/` to `{key:'reformer', label:'Pilates'}` and `/lagree/` to `{key:'reformer', label:'Lagree'}`; `passesDisciplineFilter(selected, groupLabel)` wired into the timetable loop and quick counter; tests in `cards.test.js`.
3. **Gym grid.** `.fr-gymrows` grid `repeat(3, minmax(0,1fr))`; `.fr-gymrow` and `.fr-logo-plate` get `min-width:0; width:100%; overflow:hidden`; logos clamped to `max-width:100%`, height 15 px.
4. **Your Gyms.** `settings.js`: name only as `title`/`aria-label`/`alt`; mobile (`max-width:768px`) rows = logo / email + `psycle-btn-mini` actions / status + auth date; row click (outside Re-authenticate/Unlink) calls `layout.__activateSettingsSection('gym-' + gymId)`; `activateSection` keeps `navHistory` so Back returns to `gyms`.
5. **Gym pane.** `gym-settings-section.js`: no `<h3>`/eyebrow; badge beside logo in `.psycle-gym-settings-heading`; email + buttons in `.psycle-gym-conn-inline-row`.
6. **Rail polish.** Icons, spacing, sheet animation, `wireDragToDismiss`.

### B verification (main checkout)

- Server suite: 61/61 passed (`npm run test:server`). Client: 42 vitest suites, 307 tests passed. Client build clean (Vite, 667 ms).
- Deployed to `sweat-dev.wingfield.tech` via `./deploy.sh`.
- Chrome CDP (emulated iPhone 14): tap 4.5 ms / deselect 3.2 ms; gym grid 114/114/114 px; Your Gyms rows have no name text, email and buttons on one row, status below email; JAB row drills to `psycle-settings-pane-gym-jab-boxing`; gym pane has no h3 name, badge aligned with logo, email and buttons inline; Back returns to `psycle-settings-pane-gyms`.

## Historical checklist (superseded 2026-10-08)

Status key: [x] done, [ ] not done.

### Build

- [x] U4-19 phases 4-8 built 2026-10-06 on `followups-2026-10-06`. Follow-up: wire search `q` to the search UI, committed locally and verified in Chrome 2026-10-08. Still open: desktop modals push no history entry; `server.js` caches the templated `index.html` for the process lifetime (restart after a rebuild).
- [x] Follow-up from item 3: stop the scheduler, poller and quick-book applying stored rows for non-flag studios. Verified: spotmap saves drops rows for non-flag; quick-book fast path doesn't apply rows (uses slots only); scheduler/poller apply without flag-check but rows don't reach DB from save paths.
- [ ] Follow-up from item 3: merge the timetable's own floor-plan renderer into `spotmap.js`.
- [ ] Decision: tapping an unlinked gym in the quick-selector shows a toast only; open the connect flow instead? (`settings.js` does not export the link form.)
- [ ] Search results with ~200 matches take ~280 ms; no incremental rendering added.

### Bugs found 2026-10-06, not fixed

- [x] FIXED 2026-10-06 (`slotKey()` in `spotmap.js`; callers in `timetable.js` stop coercing; test `spotmap-slotkey.test.js`). Was: `client/src/ui/spotmap.js` coerces non-numeric slot ids to NaN: the mock JAB spot-map editor shows "PREFERRED SPOTS NaN" (same class as C1-3; ids must stay strings).
- [x] FIXED 2026-10-06 (cache keyed by file mtime; test in `test-spa-fallback.js`). Was: `server.js` caches the templated `index.html` for the process lifetime, so a rebuilt client is not served until the server restarts (matters for local runs and any deploy that rebuilds without recreating the container).
- [x] FIXED 2026-10-06 (`client/src/api-bookings-sync-scope.test.js`). Was: client vitest missing for the booking-sync "loaded gyms" tracking in `api.js` (server side is covered by `test-booking-sync-scope.js`).

### Verification gaps

- [ ] Search: the exact "Aarmy" gym-suggestion case (mock data has no Aarmy gym) and reload mid-search are untested; dark mode checked for the search UI fixes only.
- [ ] Auto-book and auto-upgrade spot-map editors not browser-tested for the row-group flag.
- [ ] Pull-to-refresh while scroll-collapse is active.
- [ ] Progressive merge-in above the scroll position while collapsed (unit-tested only).
- [ ] Real iOS / installed-PWA check for the quick-selector, scroll-collapse, rail vertical-drag fix (12b) and URL routing (iOS standalone opens external links in Safari).
- [ ] Quick-selector with real linked-gym data on the dev twin.
- [ ] U4-19 behaviour on the dev twin after deploy (clear service worker + IndexedDB caches; see the prod deploy cache gotcha in memory).
- [ ] Dark-mode screenshot of the instructor chip (12a).
- [ ] **Post-merge CDP smoke test of the merged tree (progressive load, quick-selector, scroll-collapse, URL routing, filter sheet latency).** Browser smoke test before any deploy (not covered by `npm test`).
- [x] Bugs 1 and 2 verified in browser by the user.

### Housekeeping

- [ ] Another session is editing/deploying Home-widget work (`home.js`, `home-routing.js`, `widget-registry.js`, tests; untracked). Those files shipped to dev as they stood.
- [ ] A concurrent `docker compose up -d --force-recreate` on oracle left hash-prefixed container names (`42f659bac4d6_psycle-app-dev`) at last check; re-check `docker ps` on oracle and normalise.
- [ ] `server/test-rate-limit-reads.js` was made isolation-safe (own port, temp DB, `MOCK_BOOKINGS_PATH` in `server/mock.js`); root cause (a concurrent run) inferred, not reproduced.
- [x] Main-checkout changes committed 2026-10-06.
- [ ] Fix the "4s grace" wording of `27f3181` if squashing.
- [ ] Vite dev server on :5173 died once mid-run; restart from `client/` if needed.

## Merge record (2026-10-06)

Main checkout committed first (`4ad6b4f`, `06b38fd`), then `worktree-enh-5-10-timetable` merged. Conflicts resolved keeping both sides: `timetable.js` (debounced filter sheet + gym quick-selector via `pruneToGyms`/`setGymQuick`), `settings.js` (`navHistory` Back + `syncSectionUrl`/`navigate('/settings')`), `gym-context.js` (`spotSectionPrefixes` + `catalogueGyms`), this doc (worktree version). The worktree's uncommitted `package-lock.json` change (adds the root `engines` entry already in `package.json`) was applied. Post-merge CDP smoke test of the combined tree is still **not done** (see Verification gaps).
