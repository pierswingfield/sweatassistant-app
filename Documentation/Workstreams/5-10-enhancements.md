# 5-10 enhancements session (handoff)

Session log for the batch of bug fixes and enhancements started 2026-10-05 and carried through 2026-10-05/06 on branch `modular`. Everything is **uncommitted** in the working tree. Dev twin (`sweat-dev.wingfield.tech`) was deployed several times with `deploy.sh` (dev only, never prod).

Working rules the user set: one dev subagent at a time (Sonnet), subagents report under 120 words as (1) root cause, (2) files, (3) pass/fail; Gemini offload (`flash`) for locating code; real-browser verification via Chrome CDP `127.0.0.1:9222` (one tab); stop after each enhancement with a 1-2 sentence test instruction for sweat-dev.

Test environment gotcha: the local default Node (v26) cannot load `better-sqlite3`. Run tests with **Node 20 via nvm** (what the Dockerfile and prod use).

## Done

| # | Item | Status | Notes |
|---|------|--------|-------|
| 0 | Gym settings: Preferred spot maps directly after Connection | Done, verified in browser | `client/src/ui/gym-settings-section.js` |
| 1 | Bug: mobile filter drawer "Workouts" section empty when expanded | Fixed in code, **not reproduced live** | Options now back-filled from loaded events' `discipline` when metadata is empty. `client/src/ui/workout-options.js` (+test), `timetable.js`. Root cause inferred. |
| 2 | Bug: quick-book overlap/confirm loop | Fixed in code, **not browser-verified** (mock has no overlap) | Overlap modal once per attempt; acknowledging it continues straight through (also through first-time setup) with no second confirm tap; busy guard. `client/src/ui/quickbook-flow.js` (+test), `timetable.js`. |
| 3 | Enhancement: per-studio row-group selector flag | Done, user confirmed on sweat-dev | Flag lives in `server/gyms.config.js` (`spotMap.rowGroupStudios`, ids or name pattern; default off; Psycle = `^ride`). Flows via `providers/spot-map.js` to `studio.rowGroups`. UI decision in one place: `spotmap.js` (`studioHasRowGroups`, `rowSelectorVisible`). Editors drop stored rows on save for non-flag studios. |
| 5 | Enhancement: timetable keyword search | Built and iterated, deployed to dev | See "Search design" below. |
| 6 | Enhancement: instructor filters per gym | Built, browser-verified, deployed to dev, user says it works | `gymId:id` tokens in `client/src/ui/instructor-filter.js` (+test). Legacy bare ids migrate on read. |

## Decisions made

- Row-group flag: config in `gyms.config.js` (not admin UI). Admin-managed gym onboarding/config is logged as **F-16** in `F-future-features.md`.
- URLs (enhancement 4): **clean paths**, state = day + filters + search `q`; push history on tab/day/filter-set (merge rapid toggles ~1s), modals push; deep-link banner with Clear returning to saved defaults, link filters never overwrite saved defaults; `/` stays the timetable until the F-10 homepage. Plan in `U4-19-url-routing-and-deep-links.md` (8 phases, about 29 h). **User wants to review the plan before build.**
- Search design: hybrid. Autocomplete grouped by type (instructors per gym, classes, locations, gyms, workouts) with counts; picking applies to the search scope; Enter shows a flat day-grouped list of all matching upcoming classes across loaded weeks using the normal row builder. Words are ANDed across fields (name, instructor, gym, location, discipline). Mobile: search icon in the filter bar that expands. Search has **its own filter scope**: entering search snapshots filters and starts empty, Clear restores the snapshot exactly, nothing from search is saved to defaults (`timetable-search-state.js`).
- Search speed fix: search re-renders now use the `'search'` reason, so they no longer wait on the auto-book queue and studio-prefs calls (865 ms to 14 ms under injected latency).
- Instructor filter semantics: a gym with at least one selected instructor shows only those instructors' classes; a gym with none selected is unrestricted. Never matched across gyms.

## Outstanding

Queued enhancements, in order:

1. **DONE 2026-10-05 (U4-7 + U4-2, worktree branch worktree-enh-5-10-timetable).** **Progressive timetable load**: render the timetable as soon as the first gym responds instead of waiting for slow gyms, and use the header chips as per-gym loading indicators. A workstream item for the first half already exists in `Documentation/Workstreams/` (agent must look it up and link it).
2. **DONE 2026-10-05 (worktree branch worktree-enh-5-10-timetable; pure logic `client/src/ui/gym-quick-select.js` + tests, rail in `filter-rail.js`, state in `timetable.js`; browser-verified in Chrome mobile viewport, light and dark; never writes saved defaults).** **Mobile gym quick-selector** in the filter bar: all configured gyms' small 1:1 logos (slightly larger than the location chip's, no pill) beside the Filters button. Tap = show only that gym; tap another = switch; tap the selected one = show all. Default to the gyms in the saved default filter set, or all if none saved. Deselected gyms are slightly blurred and lower contrast; shown gyms get a tiny flat green tick.
3. **DONE 2026-10-05 (worktree branch worktree-enh-5-10-timetable; pure hysteresis `client/src/ui/scroll-collapse.js` + tests, one `psycle-tt-compact` class toggled with the header hide in `main.js initHeaderAutoHide`, chip faces in `filter-rail.js`, copy `filters.locationsCompact`, CSS block at end of `styles.css`; mobile scroller is the DOCUMENT; layout-jump guard = day cells shrink 16px while the sticky block gains a 16px margin-bottom on the same transition, so scrollHeight is constant; merge-in anchor restore marks scroll busy; browser-verified in Chrome mobile viewport light and dark, desktop unchanged).** **Mobile scroll-collapse** (mobile only): while scrolling down, besides hiding the header, smoothly shrink the date selector (less padding, slightly smaller text) and collapse the locations chip (logo plus locations) into an "x locations" chip; reverse on scroll up.
4. **U4-19 URL routing**: build after the user reviews the plan.

Verification gaps:

- Bug 1 (Workouts empty) and bug 2 (quick-book overlap) were not reproduced or exercised live; test on sweat-dev.
- Search: the exact "Aarmy" gym-suggestion case (mock data has no Aarmy gym) and reload mid-search are untested; dark mode was checked for the search UI fixes only.
- Auto-book and auto-upgrade spot-map editors were not browser-tested for the row-group flag.
- Follow-ups from enhancement 3: stop the scheduler, poller and quick-book applying stored rows for non-flag studios; merge the timetable's own floor-plan renderer into `spotmap.js`.
- Search results with about 200 matches take about 280 ms; no incremental rendering was added.

Housekeeping:

- Another session is editing/deploying Home-widget work (`home.js`, `home-routing.js`, `widget-registry.js`, tests; untracked). Those files shipped to dev as they stood. A concurrent `docker compose up -d --force-recreate` on oracle left hash-prefixed container names (`42f659bac4d6_psycle-app-dev`) at last check; re-check `docker ps` on oracle and normalise if the prefix remains.
- `server/test-rate-limit-reads.js` was made isolation-safe (own port, temp DB, `MOCK_BOOKINGS_PATH` env in `server/mock.js`) after it failed in a full run; root cause (a concurrent run) was inferred, not reproduced.
- Nothing is committed. Review the full diff before committing.

## Newest requests (this turn)

- Instructor filter chip: behave like the location chip but show a count per gym; a gym with no instructor selected shows "All".
- Bug: on iOS the filter chip row can be dragged vertically and looks clipped on release; it must only scroll horizontally.

Status:

- A (instructor chip): done. With several gyms linked the chip reuses the location chip's tile: each gym's 1:1 logo plus its instructor count, or "All" when that gym has none picked. One gym keeps "N Instructors". Logic is the pure `summariseInstructorsByGym` in `client/src/ui/instructor-filter.js` (unit-tested); rendering is in `filter-rail.js`. Verified in Chrome mobile viewport (chip read "All | 2" and updates live); dark-mode chip colours read, not screenshotted.
- B (rail drag): `.fr-rail` had `overflow-x: auto` with the default `overflow-y`, so it could scroll 3px vertically (measured `scrollTop` 3 after a vertical drag). Now `overflow-y: hidden; overscroll-behavior-x: contain; touch-action: pan-x pan-y; -webkit-overflow-scrolling: touch`. `pan-y` is kept so a vertical swipe starting on the row still scrolls the page and pull-to-refresh. CDP touch emulation: a vertical drag on the row leaves `scrollTop` at 0. Real-iOS behaviour is UNVERIFIED.
- C (chip icons & tighter whitespace): added `pin` / `location` icon to `SVG_PATHS` in `cards.js`; location chip now starts with `icon('pin', 13)` and instructor chip with `icon('user', 13)` across multi-gym and single-gym cases in `filter-rail.js`. Spacing tightened in `styles.css`: `.fr-chip-body` gap 3.5px, padding `0 2px 0 6px`; `.fr-tile-part` gap 2.5px; `.fr-tile-part + .fr-tile-part` margin-left 2.5px (down from 8px); `.fr-dot` margin `0 2px`; `.fr-thin` margin-left 2.5px; `.fr-chip-x` width 20px. Verified in Chrome CDP mobile viewport.
- Note: the Vite dev server on :5173 died mid-run and was restarted from `client/`.
