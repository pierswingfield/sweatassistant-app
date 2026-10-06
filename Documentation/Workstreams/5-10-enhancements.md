# 5-10 enhancements session (handoff)

Session log for the batch of bug fixes and enhancements started 2026-10-05 and carried through 2026-10-05/06 on branch `modular`. Everything is **uncommitted** in the working tree. Dev twin (`sweat-dev.wingfield.tech`) was deployed several times with `deploy.sh` (dev only, never prod).

Working rules the user set: one dev subagent at a time (Sonnet), subagents report under 120 words as (1) root cause, (2) files, (3) pass/fail; Gemini offload (`flash`) for locating code; real-browser verification via Chrome CDP `127.0.0.1:9222` (one tab); stop after each enhancement with a 1-2 sentence test instruction for sweat-dev.

Test environment gotcha: the local default Node (v26) cannot load `better-sqlite3`. Run tests with **Node 20 via nvm** (what the Dockerfile and prod use).

## Done

| # | Item | Status | Notes |
|---|------|--------|-------|
| 0 | Gym settings: Preferred spot maps directly after Connection | Done, verified in browser | `client/src/ui/gym-settings-section.js` |
| 1 | Bug: mobile filter drawer "Workouts" section empty when expanded | Done, verified in browser | Options back-filled from loaded events' `discipline` when metadata is empty. `client/src/ui/workout-options.js` (+test), `timetable.js`. Verified in browser by user. |
| 2 | Bug: quick-book overlap/confirm loop | Done, verified in browser | Overlap modal once per attempt; acknowledging it continues straight through (also through first-time setup) with no second confirm tap; busy guard. `client/src/ui/quickbook-flow.js` (+test), `timetable.js`. Verified in browser by user. |
| 3 | Enhancement: per-studio row-group selector flag | Done, user confirmed on sweat-dev | Flag lives in `server/gyms.config.js` (`spotMap.rowGroupStudios`, ids or name pattern; default off; Psycle = `^ride`). Flows via `providers/spot-map.js` to `studio.rowGroups`. UI decision in one place: `spotmap.js` (`studioHasRowGroups`, `rowSelectorVisible`). Editors drop stored rows on save for non-flag studios. |
| 5 | Enhancement: timetable keyword search | Built and iterated, deployed to dev | See "Search design" below. |
| 6 | Enhancement: instructor filters per gym | Built, browser-verified, deployed to dev, user says it works | `gymId:id` tokens in `client/src/ui/instructor-filter.js` (+test). Legacy bare ids migrate on read. |
| 7 | Optimization: filter drawer tap latency & deselect lag | Done, verified in browser via CDP (4.5ms select / 3.2ms deselect) | In-memory matcher `countMatchingEventsQuick()`, frame-0 sheet sync `syncFilterSheetState()`, debounced 100ms timetable DOM render. `timetable.js`, `filter-rail.js`. |
| 8 | Discipline: Pilates vs Reformer vs Lagree | Done, unit-tested (307 tests) & browser-verified | Pilates (`/pilates/`) and Reformer share semantic equivalence via `passesDisciplineFilter()`, Lagree (`/lagree/`) kept distinct. `cards.js`, `copy.js`, `timetable.js`. |
| 9 | Layout: filter drawer equal 3-column gym grid | Done, verified in browser via CDP (114px each) | `repeat(3, minmax(0, 1fr)) !important`, `min-width: 0 !important; width: 100% !important;` on rows/plates, contained SVG/img. `styles.css`. |
| 10 | Settings: "Your Gyms" mobile row layout & drilldown | Done, verified in browser via CDP on sweat-dev | Name text removed (accessible on logo); Row 1 = logo, Row 2 = email (left) + buttons (right), Row 3 = status (left) + auth date (right). Tapping row drills down to gym pane; Back button returns to Your Gyms. `settings.js`, `styles.css`. |
| 11 | Settings: Gym-specific pane header & inline connection row | Done, verified in browser via CDP on sweat-dev | Name heading removed; Connected badge aligned with logo banner; email + action buttons inline on one line (`.psycle-gym-conn-inline-row`). `gym-settings-section.js`, `styles.css`. |
| 12 | UI: Filter rail icons, whitespace, animations & drag-to-dismiss | Done, verified in browser via CDP | `pin` and `user` icons on chips, tightened padding/gaps; sheet slide-in/out transition with overlay fade; drag-to-dismiss handle. `filter-rail.js`, `cards.js`, `styles.css`. |

## Decisions made

- Row-group flag: config in `gyms.config.js` (not admin UI). Admin-managed gym onboarding/config is logged as **F-16** in `F-future-features.md`.
- URLs (enhancement 4): **clean paths**, state = day + filters + search `q`; push history on tab/day/filter-set (merge rapid toggles ~1s), modals push; deep-link banner with Clear returning to saved defaults, link filters never overwrite saved defaults; `/` stays the timetable until the F-10 homepage. Plan in `U4-19-url-routing-and-deep-links.md` (8 phases, about 29 h). **User wants to review the plan before build.**
- Search design: hybrid. Autocomplete grouped by type (instructors per gym, classes, locations, gyms, workouts) with counts; picking applies to the search scope; Enter shows a flat day-grouped list of all matching upcoming classes across loaded weeks using the normal row builder. Words are ANDed across fields (name, instructor, gym, location, discipline). Mobile: search icon in the filter bar that expands. Search has **its own filter scope**: entering search snapshots filters and starts empty, Clear restores the snapshot exactly, nothing from search is saved to defaults (`timetable-search-state.js`).
- Search speed fix: search re-renders now use the `'search'` reason, so they no longer wait on the auto-book queue and studio-prefs calls (865 ms to 14 ms under injected latency).
- Instructor filter semantics: a gym with at least one selected instructor shows only those instructors' classes; a gym with none selected is unrestricted. Never matched across gyms.

## Outstanding

Queued enhancements, in order:

1. **Progressive timetable load**: render the timetable as soon as the first gym responds instead of waiting for slow gyms, and use the header chips as per-gym loading indicators. A workstream item for the first half already exists in `Documentation/Workstreams/` (agent must look it up and link it).
2. **Mobile gym quick-selector** in the filter bar: all configured gyms' small 1:1 logos (slightly larger than the location chip's, no pill) beside the Filters button. Tap = show only that gym; tap another = switch; tap the selected one = show all. Default to the gyms in the saved default filter set, or all if none saved. Deselected gyms are slightly blurred and lower contrast; shown gyms get a tiny flat green tick.
3. **Mobile scroll-collapse** (mobile only): while scrolling down, besides hiding the header, smoothly shrink the date selector (less padding, slightly smaller text) and collapse the locations chip (logo plus locations) into an "x locations" chip; reverse on scroll up.
4. **U4-19 URL routing**: build after the user reviews the plan.

Verification gaps:

- Bug 1 (Workouts empty) and bug 2 (quick-book overlap) verified in browser by user.
- Search: the exact "Aarmy" gym-suggestion case (mock data has no Aarmy gym) and reload mid-search are untested; dark mode was checked for the search UI fixes only.
- Auto-book and auto-upgrade spot-map editors were not browser-tested for the row-group flag.
- Follow-ups from enhancement 3: stop the scheduler, poller and quick-book applying stored rows for non-flag studios; merge the timetable's own floor-plan renderer into `spotmap.js`.
- Search results with about 200 matches take about 280 ms; no incremental rendering was added.

Housekeeping:

- Another session is editing/deploying Home-widget work (`home.js`, `home-routing.js`, `widget-registry.js`, tests; untracked). Those files shipped to dev as they stood. A concurrent `docker compose up -d --force-recreate` on oracle left hash-prefixed container names (`42f659bac4d6_psycle-app-dev`) at last check; re-check `docker ps` on oracle and normalise if the prefix remains.
- `server/test-rate-limit-reads.js` was made isolation-safe (own port, temp DB, `MOCK_BOOKINGS_PATH` env in `server/mock.js`) after it failed in a full run; root cause (a concurrent run) was inferred, not reproduced.
- Nothing is committed. Review the full diff before committing.

## Detailed Changes (Latest Session — 2026-10-05/06)

### 1. Filter Drawer Tap Latency & Deselect Lag
- **Problem**: Tapping a filter option (e.g. location, workout type, instructor) took 500ms to 1s to reflect in button styling (`.on`), result count (`.fr-badge`), and section summaries. Deselecting was even slower. In rare cases rapid tapping dropped clicks completely.
- **Root Cause**: `buildFilterRailCtx` invoked `rerender()` synchronously on every tap/deselect, running `renderTimetableGrid('filter')`. This traversed hundreds of classes, constructed carousel dates, re-evaluated DOM templates, ran layout/chip measurements, and destroyed/recreated DOM nodes while the filter sheet was open. Taps were dropped when DOM nodes were re-created under the user's thumb during a click event cycle. Deselecting matched even more classes, exacerbating the DOM thrashing.
- **Solution**:
  - Implemented `countMatchingEventsQuick()` in `client/src/ui/timetable.js`: an in-memory loop over `psycleEvents` (< 0.1ms) checking active filters.
  - Exported `isFilterSheetOpen()` and `syncFilterSheetState(ctx)` in `client/src/ui/filter-rail.js`.
  - While the filter sheet is open, `toggle()`, `clear()`, and `clearAll()` update state in memory, update `ctx.resultCount`, and invoke `syncFilterSheetState(ctx)` synchronously in frame 0. This updates button classes (`.on`), badge text, and accordion summaries in < 0.5ms with zero DOM rebuilds.
  - Debounced the heavy background `renderTimetableGrid('filter')` by 100ms (`scheduleDeferredFilterRender()`).
  - Added `flushDeferredFilterRender()` which is invoked synchronously on `closeSheet()` to ensure the timetable is guaranteed up-to-date upon dismissal.
- **Measured (Chrome CDP on emulated iPhone 14)**:
  - Option tap latency: **4.5ms** (from ~800ms).
  - Option deselect latency: **3.2ms**.
  - Zero dropped taps.

### 2. Aarmy / Psycle Discipline Classification: Pilates vs. Reformer vs. Lagree
- **Problem**: Official Aarmy timetable labels classes as "Pilates", but the app was mapping them to "Reformer". Furthermore, Psycle treats Reformer and Lagree as distinct disciplines.
- **Solution**:
  - In `client/src/copy.js`: added `lagree: 'Lagree'` under `COPY.disciplines`.
  - In `client/src/ui/cards.js`: updated `getDiscipline()` regex. Classes matching `/pilates/` now return `{ key: 'reformer', label: 'Pilates', icon: 'reformer' }`; classes matching `/lagree/` return `{ key: 'reformer', label: 'Lagree', icon: 'reformer' }`.
  - In `client/src/ui/cards.js`: implemented `passesDisciplineFilter(selected, groupLabel)`. Pilates and Reformer are mutually equivalent in filtering (selecting either matches classes categorized under Pilates or Reformer across all gyms). Lagree is strictly isolated and matches only Lagree.
  - In `client/src/ui/timetable.js`: wired `passesDisciplineFilter()` in the timetable event loop and quick count matcher.
  - Added unit test suite in `client/src/ui/cards.test.js`. All 42 client vitest suites (307 tests) pass.

### 3. Filter Drawer Gym Grid: Strictly Equal 3-Column Widths
- **Problem**: When 3 gyms are linked, the gym grid at the top of the mobile filter sheet had uneven column widths; Psycle's wordmark expanded the center column to ~133px while other columns shrank to ~104px.
- **Solution**:
  - In `client/src/styles.css`: updated `.fr-gymrows` to `display: grid !important; grid-template-columns: repeat(3, minmax(0, 1fr)) !important; gap: 8px !important; width: 100% !important; box-sizing: border-box !important;`.
  - Added `min-width: 0 !important; width: 100% !important; overflow: hidden !important;` to `.fr-gymrow` and `.fr-gymrow .fr-logo-plate`.
  - Clamped all brand logo images and SVGs inside the plate to `max-width: 100% !important; height: 15px; width: auto; object-fit: contain;` and cleaned up legacy `max-width: none` rules.
- **Measured (Chrome CDP)**:
  - Grid columns computed: `114px 114px 114px` (strictly 114.0px each).

### 4. Settings: "Your Gyms" Mobile Row Layout & Drill-down Navigation
- **Problem**: On mobile, gym rows in "Your Gyms" broke awkwardly across lines; text name duplicated the brand logo; tapping a gym row did not navigate to the gym's specific settings.
- **Solution**:
  - In `client/src/ui/settings.js`: removed `strong` gym name heading from rows. Set gym name as accessible `title`, `aria-label`, and image `alt` on the logo banner.
  - In `client/src/styles.css`: redesigned mobile `.psycle-gym-conn-row` grid (`@media (max-width: 768px)`):
    - Row 1: Logo banner (spans full width).
    - Row 2: Email on left (`small`, ellipsis, nowrap) + action buttons on right (`.psycle-gym-conn-actions`, `psycle-btn-mini`) on a single line.
    - Row 3: Connected health badge on left + last authenticated timestamp on right slightly below.
  - Added `cursor: pointer` and hover background styling to `.psycle-gym-conn-row`.
  - In `client/src/ui/settings.js:onGymListClick`: clicking anywhere on a gym row (outside of the Re-authenticate and Unlink action buttons) navigates directly to that gym's individual settings pane via `layout.__activateSettingsSection('gym-' + gymId)`.
  - In `client/src/ui/settings.js:activateSection`: tracked `navHistory = []`. When drilling down from `gyms` to `gym-${gymId}`, clicking the mobile `< Back` button or swiping back pops history and returns directly to `gyms` before exiting Settings.

### 5. Settings: Gym-Specific Pane Layout & Inline Connection Card
- **Problem**: Gym-specific settings pane displayed duplicate gym name text; Connected chip was misaligned with the logo banner; email and buttons broke across lines in the Connection card.
- **Solution**:
  - In `client/src/ui/gym-settings-section.js`: removed `<h3>` gym name and `.psycle-eyebrow` text. Set gym name as accessible attributes on the logo banner.
  - Connected status badge is placed beside the logo banner inside `.psycle-gym-settings-heading` (`justify-content: space-between; align-items: center`), aligning it horizontally with the logo.
  - In `client/src/ui/gym-settings-section.js`: wrapped email and buttons in `.psycle-gym-conn-inline-row`.
  - In `client/src/styles.css`: styled `.psycle-gym-conn-inline-row` with flex `justify-content: space-between; align-items: center; gap: 12px;` so email truncates if necessary while the mini buttons stay inline on one row without breaking.

### 6. Filter Rail Chip Polish, Animation & Drag-to-Dismiss
- **Solution**:
  - Added `icon('pin', 13)` and `icon('user', 13)` to location and instructor chips in `client/src/ui/filter-rail.js` using paths in `client/src/ui/cards.js`.
  - Tightened chip padding, dot margins, and item gaps in `client/src/styles.css`.
  - Added smooth cubic-bezier slide up/down animation (`translateY(100%)` to `translateY(0)`) and background overlay fade in `client/src/styles.css`.
  - Implemented `wireDragToDismiss` touch event handling on sheet handle and header in `client/src/ui/filter-rail.js` (> 70px drag threshold).

---

## Verification Summary

1. **Server Suite**: 61/61 suites passed (`npm run test:server`).
2. **Client Unit Tests**: 42/42 vitest suites (307 tests) passed (`npm run test:client`).
3. **Client Build**: Production bundle built cleanly with Vite in 667ms (`npm run build:client`).
4. **Live Dev Twin Deployment**: Deployed to `sweat-dev.wingfield.tech` via `./deploy.sh`.
5. **Real-Browser Verification (Chrome CDP on 127.0.0.1:9222, emulated iPhone 14)**:
   - Filter sheet tap latency: 4.5ms on select, 3.2ms on deselect.
   - 3-column gym logo grid: 114.0px / 114.0px / 114.0px (strictly equal).
   - "Your Gyms": verified all 3 rows (Aarmy, JAB, Psycle) have no text name (`hasStrongName: false`), email and buttons on one row (`emailActionsSameRow: true`), health below email (`healthBelowEmail: true`).
   - Drilldown: clicking JAB row navigates to `psycle-settings-pane-gym-jab-boxing` (`drilledDown: true`).
   - Gym pane: verified `hasH3GymName: false`, `brandAndBadgeAligned: true`, `emailAndButtonsSameRow: true`.
   - Back button: clicking `< Back` returns to `psycle-settings-pane-gyms` (`returnedToGyms: true`).

---

## Proposed Commit Summary (DO NOT COMMIT YET)

```text
ui: optimize filter drawer latency, refine gym settings layout, and balance disciplines

- Timetable filter drawer tap optimization:
  - Add in-memory event matcher countMatchingEventsQuick() for instant (<0.1ms) count evaluation.
  - Implement syncFilterSheetState() in frame 0 for instant button active states and badge updates.
  - Debounce background timetable DOM rendering by 100ms while filter drawer is open; flush on close.
  - Measure tap latency drop from ~800ms to 4.5ms select and 3.2ms deselect with zero dropped taps.

- Discipline classification (Pilates vs. Reformer vs. Lagree):
  - Add COPY.disciplines.lagree and map /lagree/ to distinct Lagree discipline.
  - Distinguish /pilates/ with label 'Pilates' while keeping 'reformer' token and icon.
  - Introduce passesDisciplineFilter() equating Pilates and Reformer in filtering while isolating Lagree.
  - Add unit test coverage in cards.test.js (307 tests passing).

- Filter drawer 3-column equal gym grid:
  - Enforce repeat(3, minmax(0, 1fr)) with zero min-width on rows and logo plates.
  - Prevent SVG/image overflow so all 3 columns measure mathematically equal (114px each).

- "Your Gyms" settings page layout & drill-down:
  - Remove redundant gym name text, retaining accessible label/alt on brand logo banners.
  - Reorganize mobile row into clean 3-row grid: full-width logo, inline email + action buttons, and status + auth date below.
  - Enable row click to drill down directly into that gym's individual settings pane.
  - Maintain navigation history stack so mobile Back button returns to Your Gyms before exiting.

- Gym-specific settings pane layout:
  - Remove text heading and eyebrow, aligning Connected status badge with the brand logo banner.
  - Wrap email and action buttons in psycle-gym-conn-inline-row so connection actions stay on one line.

- Filter rail chips & animation:
  - Add pin and user icon indicators with tightened whitespace.
  - Add smooth slide-up animation and drag-to-dismiss gesture handling.

Files modified:
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

