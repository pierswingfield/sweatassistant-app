# Onboarding and share-sheet polish — 7 November 2026

## Before changes

Verified against local mock data in the user's real Chrome over CDP 9222. At 320 and 390px, optional setup cards use wrapped flex layout and intrinsic-width 36px actions, so actions move according to label length and available width. Auto-Upgrade's checkbox sits inside the narrow heading text column. The period buttons in Share My Bookings have no base `.fr-pills` / `.fr-pill` styles; measured height is 24px and radius 0, with browser-default gray backgrounds. Selected state changes the background only.

Evidence: `onboarding-before-320.png`, `onboarding-before-390.png`, `share-before-390.png`. No live gym writes or production-account changes were used.

The existing privacy strings overstate encryption/deletion. Source check confirms gym passwords encrypted with AES-GCM, provider sessions encrypted at rest and opened for background calls, and account passwords hashed. Account deletion removes live account data; backups and external copies are separate. The legal drafts remain unpublished.

## After changes

Setup cards now keep actions on a consistent full-width row, 44px tall at 320/390/1280px. The Auto-Upgrade checkbox occupies its own row, remains off by default, and native Space toggles both the checkbox and completion status; it was toggled off again before finishing. Share periods use scoped themed pills with visible selected/focus states. Repainting restores focus to the changed period, gym or TBC control.

Real Chrome checks: 320×844 and 390×844 light, 320×844 and 1280×900 forced dark. No document horizontal overflow. Period filters with runtime-only, date-aligned mock fixtures: 1 week gives 3 classes/1 TBC, Enter on 3 days gives 2/1, 2 weeks gives 4/1, Space on TBC gives 3 confirmed. Focus remains on the changed control. No native share was sent. Screenshot files remain local evidence, outside the release export. Service workers, CacheStorage and IndexedDB were cleared before the after checks; local mock fixtures were confined to this owned tab.

```text
npm test (Node v22.23.4): 121/121 server suites passed
Client: Test Files 117 passed (117); Tests 959 passed (959)
npm run build:client: built in 978ms
Vite warnings: existing mixed static/dynamic imports and chunk larger than 500kB
Git diff --check: no whitespace errors
```

No new unit tests were added for the reversible layout/copy changes. Existing suites cover onboarding routing and share selection/formatting; the real-browser checks cover native checkbox/keyboard behavior and the visual layout. Physical iOS testing remains owner acceptance.
