# Personal stats polish — 8 November 2026

Before changes, real Chrome on the signed-in dev site showed “At least … from available history” and “Includes saved history from studios you have turned off.” The authenticated aggregate returned HTTP 200: Aarmy, Homerun, JAB and Psycle were ready; Barry’s was disabled; none reported a failed sync. Server coverage marks a disabled link as partial, which explains the notice and qualified streak; the browser evidence does not establish an active provider failure. Existing stored history remains included. No gym or account settings were changed.

Code inspection also found focus/hover populating a visible per-day readout, and personal carousel dots using 44px-wide buttons instead of the Team dots' 7px marks and 6px gaps. Changes below address the requested presentation; no unproven history-sync fix is claimed.

Read-only follow-up: the dev container's `BARRYS_UK_ENABLED` is true and the `gyms` registry row is enabled; the authenticated account's Barry's link is active but `account_enabled` is 0. The account switch alone blocks outbound sync. This does not establish why or when it was switched off. No configuration or account preference was changed.

After changes, the user's real Chrome at 390px on the local fixture displayed “18 weeks / streak”, four charts and no coverage note or visible daily readout. DOM/computed-style checks found 30 focusable daily bars with accessible labels, and dots at 7px width, 6px gap and 8px top margin, matching Team CSS. At that point the dev site still had the previous release; the post-deploy browser check is recorded below.

Verification: Node 22.23.4 `npm test` passed 122/122 server suites and 122 client files / 982 tests. Targeted personal-stats test passed 7/7 after first failing on the old wording and note. `npm run build:client` succeeded with Vite chunk warnings; `git diff --check` passed. The after screenshot is `local-mobile-after.png`.

A separate whole-request error path was also reproduced in a focused integration test: a failed first load formerly showed the shared widget error and Retry. The stats widget now hides on a first-load failure and retains already-rendered stats on a failed same-account refresh; the integration and widget-framework tests pass (26/26). Other widgets keep their existing error handling.

Final rerun after the whole-request error handling change: `npm test` passed 122/122 server suites and 122 client files / 983 tests; the client build succeeded (Vite chunk warnings only).


## DEV deployment receipt — 8 November 2026

Exact application commit `ce8a4489c0f9c91fd9c9dc0a45c6c3656738d013` was pushed to `origin/teams` and deployed from a clean `git archive` with `./deploy.sh --dev` to `sweatassistant-dev` only. `npm run build:client` succeeded locally (130 modules; existing mixed-import and >500 kB warnings); `git diff --check` passed. The pre-deploy `npm test` rerun for this exact source tree passed 122/122 server suites and 122 client files / 983 tests. The DEV image build also completed (130 modules; same warnings).

Post-deploy: container Up, restart count 0, Node `v22.23.4`, bind `100.86.226.52:3005->3000`; health returned HTTP 200 with `status: ok`; SQLite integrity returned `ok`; `docker diff` listed only `A /data`; `.env` and compose SHA-256s unchanged. Served JS and CSS SHA-256s match local output (`1378cfe2…` and `e9956091…`). WAL-safe backup completed with `=== OK ===`; DEV snapshot integrity was `ok` and encrypted upload succeeded. Rollback image `sweatassistant-dev:rollback-personal-stats-polish-20261108`; records in `~/services/sweatassistant-dev/rollback-personal-stats-polish-20261108/`. Production and experiment were not targeted and remained Up with their prior start times.

The existing signed-in Chrome tab initially showed stale assets. A read-only reload redirected it to Cloudflare Access login, so authenticated post-deploy UI acceptance could not be completed without re-authentication; no credentials were entered, and storage, preferences, bookings, and gym state were not changed. Local real-Chrome fixture acceptance remains the UI evidence above.
