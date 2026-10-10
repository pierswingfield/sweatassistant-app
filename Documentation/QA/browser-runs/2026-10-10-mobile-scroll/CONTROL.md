# Mobile timetable and page-scroll QA — 2026-10-10

## Change and basis

The mobile timetable uses the page body as its scrollport, so sticky date/filter rails move within the elastic region; short grids can have no overflow. The latest reported visual defects were cross-checked in local real Chrome against the merged master state. CSS adjusts the timetable body to zero horizontal gutters, keeps the fixed bottom nav flush, isolates one-pixel overflow for short grids, removes collapse compensation gap, centers the ellipsis hit area, and prevents shared AARMY marks from being vertically stretched. The existing `timetable.js` edit fixes an undefined `startDate` reference in the booked-event penalty indicator using `event.startAt`.

## Browser verification

User Chrome, local Vite app, mock Psycle auth, responsive CDP viewport; no live gym writes. At 390×844 and 314×682: timetable body horizontal padding 0; date row spans viewport with full date; sticky rails pinned; nav begins exactly at list viewport bottom; 44px kebab glyph center equals hit-area center; filter rail left inset 8px. A one-result Saturday timetable grid has exactly 1px overflow with no additional visible blank gap. Down-scroll sets compact/header-hidden state; up-scroll restores expanded state, and the timetable list remains flush with nav. App-body has no horizontal border. CSS asset hides scrollbars. Shared AARMY mark selector was rendered in a local DOM fixture using `/gyms/aarmy-mark.png?v=2` (natural 400×459, rendered 33.109×38 with `object-fit: contain`); actual AARMY booking rows are absent from mocks, so actual Auto-Book/My Bookings logo rendering was not exercised. Native iOS bounce and physical touch behavior remain device-unverified.

## Automated checks

From Node 20.19.0 before final master integration: `npm test` — server **81/81 suites passed**, client Vitest **74/74 files and 562/562 tests passed**. `npm run build:client` — Vite **83 modules transformed**, build completed; existing dynamic/static import and chunk-size warnings only. `git diff --check` passed. These checks will be rerun on final master commit before deployment.
