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


## Production release

Exact source `c98ef9a6d2072eb7b3a736011c9c737b110ae53f` was committed/pushed to `origin/teams` and deployed from an immutable `git archive` export to production and landing only. The landing rsync explicitly preserved `rollback-domain-20261107`; no domains, Nginx config, exposure, bindings, environment, database schema, dev or experiment deployment changed. The legal Markdown is outside all Docker `COPY` paths that serve public files.

Rollback records (private, outside Git): `/home/ubuntu/release-backups/dibs-ui-polish-20261107/` contains WAL-safe SQLite backup (`integrity_check: ok`), env snapshot, before counts and immutable old app/landing image IDs. Images are tagged `sweatassistant-sweatassistant:rollback-ui-polish-20261107` and `dibs-landing-dibs-landing:rollback-ui-polish-20261107`. For a code rollback use the saved image with the existing compose service and live data; do not restore the DB for a CSS/copy rollback.

```text
docker ps:
  sweatassistant              Up 28 seconds   3000/tcp
  dibs-landing                Up 45 seconds   80/tcp
  sweatassistant-experiment   Up 36 minutes   100.86.226.52:3006->3000/tcp
  sweatassistant-dev          Up 36 minutes   100.86.226.52:3005->3000/tcp
RestartCount: prod 0; landing 0
Node: v22.23.4
Internal/public /api/health: HTTP 200, status ok
PROD ENV: unchanged
DB integrity_check: ok
COUNTS UNCHANGED: True
users=2; user_gyms=1; teams=0; team_members=0; auto_bookings=0; auto_upgrades=0
/terms: 404; /privacy: 404; /Documentation/Legal/TERMS-DRAFT.md: 404
/sw.js: HTTP 200, Cache-Control: no-cache
/api/health: HTTP 200, Cache-Control: private, no-store
Prod error-signature lines since restart: 0
```

Public asset SHA-256 matches the local verified build byte-for-byte:

| Asset | SHA-256 |
|---|---|
| `index-B60gyQP2.css` | `25ed5dc293a97ef92439d477b62d4b7b9a6d0c8ffc5742b0a658fdebf3edaa03` |
| `index-C8VY_iNo.js` | `781f8878d3aeef7daab27398bfb38a4c0fd0336b207605a2d9cd2c59ca7ed7e6` |
| `share-sheet-C7800jB6.js` | `c650900f5b84b060487b1e2a9d7a7fcf99f650f326961c1220529e69f24544a1` |

The public welcome and landing copy loaded in the same owned real Chrome tab at 390px without horizontal overflow. No production sign-in or gym action was performed. Public unauthenticated Python urllib was rejected HTTP 403 by the existing edge; curl and the user's Chrome succeeded. This is recorded as a failed fetch, not a product failure.

Documentation discovery used two successful Gemini Flash calls in this UI/release phase; exact code, browser behavior and release outputs were checked directly. The preceding documentation/legal sweep has its own provenance in the audit. Registry and infrastructure changelog updated in the same turn.
