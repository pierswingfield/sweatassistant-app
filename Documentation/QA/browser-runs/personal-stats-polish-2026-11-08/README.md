# Personal stats polish — 8 November 2026

Before changes, real Chrome on the signed-in dev site showed “At least … from available history” and “Includes saved history from studios you have turned off.” The authenticated aggregate returned HTTP 200: Aarmy, Homerun, JAB and Psycle were ready; Barry’s was disabled; none reported a failed sync. Server coverage marks a disabled link as partial, which explains the notice and qualified streak; the browser evidence does not establish an active provider failure. Existing stored history remains included. No gym or account settings were changed.

Code inspection also found focus/hover populating a visible per-day readout, and personal carousel dots using 44px-wide buttons instead of the Team dots' 7px marks and 6px gaps. Changes below address the requested presentation; no unproven history-sync fix is claimed.

Read-only follow-up: the dev container's `BARRYS_UK_ENABLED` is true and the `gyms` registry row is enabled; the authenticated account's Barry's link is active but `account_enabled` is 0. The account switch alone blocks outbound sync. This does not establish why or when it was switched off. No configuration or account preference was changed.

After changes, the user's real Chrome at 390px on the local fixture displayed “18 weeks / streak”, four charts and no coverage note or visible daily readout. DOM/computed-style checks found 30 focusable daily bars with accessible labels, and dots at 7px width, 6px gap and 8px top margin, matching Team CSS. The dev site remains unchanged pending deployment.

Verification: Node 22.23.4 `npm test` passed 122/122 server suites and 122 client files / 982 tests. Targeted personal-stats test passed 7/7 after first failing on the old wording and note. `npm run build:client` succeeded with Vite chunk warnings; `git diff --check` passed. The after screenshot is `local-mobile-after.png`.

A separate whole-request error path was also reproduced in a focused integration test: a failed first load formerly showed the shared widget error and Retry. The stats widget now hides on a first-load failure and retains already-rendered stats on a failed same-account refresh; the integration and widget-framework tests pass (26/26). Other widgets keep their existing error handling.

Final rerun after the whole-request error handling change: `npm test` passed 122/122 server suites and 122 client files / 983 tests; the client build succeeded (Vite chunk warnings only).
