# Optional gym login and policy acceptance — 9 November 2026

Branch: `feat/optional-gym-login-policy`. This receipt covers the local implementation and review before deployment; the later experiment-only release is recorded separately in [the deployment receipt](../gym-login-policy-experiment-2026-11-09/README.md).

## Before evidence

Real user Chrome 156 CDP at 127.0.0.1:9222, one owned tab reused.
Correct local Vite command: `npm run dev --prefix client -- --host 127.0.0.1`.
Passing an extra positional host via the root npm script makes Vite use that string as its root; that reproduces the earlier blank app. The correct invocation visibly rendered signup and onboarding with `app-ready` and no Runtime exceptions.

- Visible signup: zero checkboxes; local test account created without acceptance (`before-signup.png`).
- Visible onboarding gym form: email/password only, no remember checkbox (`before-gym-login.png`).
- Source: `auth.linkGymAccount` unconditionally stores email/encrypted password; `triggerAutoRelogin` clears working session on every renewal failure including transient outages. `handleSignup` stores no agreement version. Existing account migration UX omitted by owner instruction: all existing accounts are test accounts.
- Approved policy wording will be published locally with necessary optional-storage corrections only.

## Verification

Final outputs and acceptance evidence are recorded below. No production or live provider writes were performed.

## Implemented locally

- Account signup requires a genuine boolean acceptance and exact shipped Terms/Privacy versions; account creation and server timestamp/version recording are one transaction. No existing-test-account acceptance prompt or fabricated history.
- Approved policies are published in source at `/policies/terms.html` and `/policies/privacy.html`, with immutable `*-2026-11-09.html` copies. Signup, About and the remembered-login notice link to them. An accessible shared modal reader keeps form state mounted, including on mobile.
- Every gym login surface uses one initially unticked control and the exact owner-supplied disclosure copy. Only boolean `true` stores login credentials after successful authentication. Session-only retains encrypted normalized provider session/refresh material and strips echoed login inputs from stored profile/session data; no fallback to the Dibs identity.
- Forget gym login is distinct from unlinking and has confirmation. It clears reusable credentials/permission, retains session and setup, and advances a connection revision. Renewal and manual-login commits check revisions; late work cannot undo forgetting.
- Definitive auth failures use a persistent incident, notification outbox and safe reason. Concurrent foreground/background attempts share renewal and deduplicate incidents; rejected credentials are not retried repeatedly. Refresh-only renewal remains supported. Network/5xx/429 do not invalidate the connection. Push delivery obeys preferences, retries transport failures on the existing background cycle and uses a stable notification tag.
- Availability gates operational calls, queues, provider backstop, Team projections, history/statistics, calendar and UI. A failed gym remains linked in Settings. Home warnings survive reload/resume/offline and link to per-gym reconnection. Cache epochs, revision checks, persistent availability and a real reload retire late/stale data. Fresh booking/waitlist sync precedes restored availability; release fences prevent missed Auto-Book work firing late.

## Final checks (actual outputs in adjacent files)

| Check | Output | File |
|---|---|---|
| Node 22 full `DB_PATH=:memory: npm test` | `123/123 server suites passed`; `Test Files 123 passed (123)`; `Tests 990 passed (990)` | `tests-final.txt` |
| Final client test rerun after final copy changes | `Test Files 123 passed (123)`; `Tests 990 passed (990)` | `client-final.txt` |
| Focused lifecycle suite | `13/13 gym-login-policy checks passed` | `focused-final.txt` |
| Team projection, including expired gym visibility/counts | `14/14 passed` | `team-projection-final.txt` |
| Mutation: change omitted remember choice to true | Two expected failures, `11/13 ... checks passed`; restored code `13/13` | `mutation-default-opt-in.txt`, `focused-final.txt` |
| Actual test-runner source, inherited app DB path | `1/1 server suites passed`; `PASS: actual runner source overrides inherited application DB_PATH before running fixtures.` | `runner-isolation.txt` |
| Final client build | `✓ built in 1.19s`; existing >500kB chunk warning | `build-final.txt` |
| Git whitespace | `git diff --check`: exit 0, no output | final audit |

Initial failures are retained: first full run 15/122 server suites failed; second 3/122 failed. They exposed fixtures needing explicit acceptance/remember choices, obsolete repeated-rejection expectations, and actual integration/config/markup issues, all addressed. An initial client run failed 3/990 checks (IDB fake transaction completion, copy-catalog guard, test app-name fixture); final run passes. `tests-third.txt` also records the earlier full PASS.

One subsequent run (`tests-fourth.txt`) was interrupted: the shell inherited the **agent-owned temporary browser DB** path into tests. No user/production database was involved. That temporary database was preserved, a new isolated browser database was created, and the runner was tightened to force `:memory:` exactly as TESTING.md describes. `tests-final.txt` explicitly forces memory as well; the separate probe verifies the runner itself ignores an inherited application path.

## Real Chrome acceptance

Chrome 156 on CDP 127.0.0.1:9222. One owned tab, reused; no user tab navigated or closed. Local test accounts and provider mocks only, with no live gym booking, cancellation, purchase or provider write.

- Before: visible signup had zero checkboxes; visible onboarding had no remember control.
- After: signup checkbox initially false; native validity false unticked; direct signup without acceptance returned HTTP 400. Correct versions created the test account and server timestamp. Reading Terms and returning preserved email/password and unticked state.
- Onboarding: unchecked and checked notices matched the owner text exactly; checked text contained both named policy links. Psycle session-only stored no login email/password; JAB opt-in stored encrypted credentials; both sessions were ciphertext. Stored raw profiles contained no echoed login emails (`browser-database-check.txt`).
- Forget: confirmation and Keep saved login action appeared; confirmed removal showed Session only, hid the forget action and retained working session/link. Settings reauthentication and Home reconnection opened unticked.
- One gym expired: persistent Home warning named Psycle; JAB's membership/history/statistics remained; Psycle operational data disappeared. Reauthentication succeeded with fresh sync, restored both gyms and cleared the warning.
- Both gyms expired: both warnings appeared, Dibs login remained, no Connect your first gym state. Built PWA reopened offline under the existing service worker; both warnings persisted and no stale operational gym data appeared (`after-all-gyms-expired.png`, `after-offline-reopen.png`).
- Mobile viewport 390×844: About contained both policy links; policy dialog had a readable document, dialog semantics and no horizontal overflow (`after-mobile-policy.png`, `after-mobile-about.png`).

Preview caveat: offline testing used Vite preview of the production build, with the actual local API server in mock mode. Vite preview does not run the production server's app-name template substitution, so its offline shell shows `__APP_NAME__`; production templating is separately covered by the passing app-name suite. This is not a deployment. No real push service/device delivery was exercised; outbox/preferences/adapter failures are covered locally. Physical iPhone behavior and real provider rejection shapes beyond the existing captures remain untested.

## Approved policy wording changes

Canonical approved copies preserve the prior drafts except for titles/publication/version metadata, working published links, and these feature-alignment changes:

- Terms: unconditional permission to save gym credentials now distinguishes retained provider sessions from optional remembered login email/password, successful authentication, forgetting and paused reconnection.
- Privacy: collection table makes saved login optional; credentials section explains initially unticked choice, retained encrypted provider session/refresh material, successful-only saving, forgetting and paused reconnect. Provider profile contact information is explicitly never a replacement login identifier.
- Backup/retention wording and remaining factual qualifications are preserved. The operations note requires reapplying later forget choices before enabling restored backups, or clearing restored reusable credentials when reconciliation is unavailable. No promise of forensic or historical-backup erasure is made.

The original draft files and historical legal research remain. Owner approval supersedes the prior publication blocker for this implementation; no independent legal-compliance conclusion is asserted.

## Worktree and limits

Branch `feat/optional-gym-login-policy` from `teams` HEAD `43592eb`; changes are uncommitted. Original uncommitted roadmap and plan inputs were preserved and updated with the implementation receipt. No deployment, push or merge.

The worktree's `.git` file still points at its former Linux location. All Git actions used `GIT_DIR=/Users/pierswingfield/Desktop/AI Projects/psycle chrome/App/.git/worktrees/App-teams` and this worktree as `GIT_WORK_TREE`; no unrelated repository metadata was rewritten. Test-produced `server/mock_bookings.dbjson` changes were restored to the clean baseline.

Gemini provenance: two Flash locator calls, followed by targeted source verification. Browser behavior, source edits and final judgement remained with the implementation agent.

Final browser follow-up on the latest build: restoring JAB alone left only Psycle's warning, JAB operational widgets loaded, there were zero widget errors, and the completed login form's password was empty (`after-final-mixed-availability.png`, visually inspected). The initial mixed-state favourites error was fixed by excluding reconnecting gyms from that widget's all-linked-gym lookup; the final screenshot verifies the result. Final About copy also explicitly describes optional saved login details. Markdown local-link verification passed for five changed documents; no documentation-specific verify command is declared.

Cleanup: restored online/device-metrics state, closed only owned Chrome target `2AD59AC29EEF9F76B48A66B4D3BD80B8` (`Target is closing`), stopped the agent-owned API and Vite preview processes. Preserved temporary local test databases; did not touch the preexisting server on port 3000. All source changes remain uncommitted for review.

## Terra review corrections — 9 November 2026

All three requested findings were reproduced and corrected, without deployment:

1. Background retry rejection: `poller.fetchFromGym()` and booking sync's `listWithRelogin()` previously returned/threw a second provider 401 after renewal while leaving the gym active. They now record the same persistent login-required incident and stop later background attempts. Non-authentication errors and 429 remain transient.
2. Scheduler stale rejection: its post-renewal request previously marked login required without a revision fence. The shared `gym-connection.sessionProof()`/`rejectSession()` helpers bind the retry to its exact stored access token **and** connection revision. A late failure cannot clear a newer manual login or a session replacement from an existing writer that does not advance the revision. The same proof guards poller and booking sync. Stale operations stop without changing the new connection or consuming the preserved queue entry.
3. Overlap projection: `competingContextFor()` now applies `db.isUserGymAvailable()` to booked-cache rows, matching its queue filter. Unavailable classes do not appear in overlap warnings; healthy booked and queued conflicts still do.

Evidence:

- Original review receipts: `review-background-401.txt`, `review-revision-fence.txt`, `review-overlap.txt` (including the review's initial incomplete fake-provider attempt).
- Before-fix new worker suite: `review-retry-before.txt` — **8/12 passed, four expected failures** reproducing the two background incident failures and scheduler races.
- Corrected worker suite: `review-retry-after.txt` — **13/13 passed**. It drives actual poller, booking-sync and scheduler workers; includes same-session rejection/deduplication, healthy queue retention, newer manual-login and same-revision-token races, and post-renewal 429/503 preservation.
- HTTP regression: `review-overlap-before-test.txt` fails for the extra unavailable booked warning; `review-overlap-after-test.txt` passes, asserting both unavailable booked/queued rows disappear and both healthy conflicts remain.
- Real Chrome before/after request receipts: `review-chrome-overlap-before.json` contains healthy JAB and unavailable Psycle booked warnings; `review-chrome-overlap-after.json` contains only the healthy JAB warning. Home still names the unavailable gym, and the Dibs login remains. `review-chrome-connection-after.png` captures the connection state. Only one owned Chrome tab was used, with service worker, CacheStorage and IndexedDB cleared before after-verification. No live provider writes.
- Full verification after corrections: `review-full-tests.txt` — **124/124 server suites passed; 123/123 client test files passed, 990/990 client tests passed**. No remaining failures.
- Client build after corrections: `review-build.txt` — **built in 1.05s**, with the preexisting chunk-size warning. No client code changed for these corrections.

The branch remains `feat/optional-gym-login-policy`, uncommitted, with all prior implementation preserved. These corrections supersede the earlier review findings; original failing receipts remain available.

Review-correction cleanup: the one owned Chrome target was closed (`review-browser-cleanup.txt`: `Target is closing`); agent-owned API/preview processes were stopped. `git diff --check` passed with no output (`review-whitespace.txt`), and receipt/plan local Markdown links passed. No source changes were made after the final passing checks. Tracked mock-booking fixtures remained clean.

## Bounded recheck: Auto-Upgrade mutation retries — 9 November 2026

The next Terra recheck found that the Auto-Upgrade `swapSpotsWithRelogin()` and `bookSlotWithRelogin()` helpers still returned a rejected post-renewal session without creating an incident (`review-recheck-mutation-retry.txt`: eight rejected calls, four renewals, active connection, no incident). This was an additional missed path; the earlier corrections alone were incomplete.

Both actual mutation helpers now use the shared `gym-connection.retrySessionCall()`. It invokes the supplied operation exactly once, checks both returned and thrown 401 responses, and applies the existing token-plus-revision transition. It performs no renewal or retry loop itself. Therefore the calling ladder still has only its original operation and its one existing 401 retry; successful responses do not cause another write. The helpers also check connection availability before starting, so later invocations cannot keep renewing a rejected session.

The exact `triggerAutoRelogin` call-site audit is preserved in `review-retry-callsite-audit.txt`. All **11 existing post-renewal provider operations** now use this same guard: scheduler request/booking; poller request/swap/booking/bookings-read; booking sync; calendar; class history; admin reads; normalized routes. The remaining proactive `/my-gyms` renewal performs no post-renewal provider operation and remains in the existing adapter-owned renewal ladder. Scheduler's old independent expiry push was removed from its retry catch: the persisted incident owns the deduplicated warning, while a transient outage remains transient.

Regression evidence:

- `review-mutation-before.txt`: **25/29 passed**, with four expected failures for returned/thrown final 401 in the two mutation helpers.
- `review-mutation-after.txt`: **29/29 passed**. Tests call the real exported mutation helpers, rather than copies. They assert exactly one successful mock mutation, no more than the original attempt plus the existing retry, no renewal after the incident, returned/thrown 401 handling, 429/503 preservation, and races against both a newer successful login and a same-revision session replacement. Previous actual scheduler/background regression cases remain in the same suite.
- `review-mutation-full-tests.txt`: **124/124 server suites passed; 123/123 client test files passed and 990/990 client tests passed**. This is the final-source run after the shared guard and mutation regressions.
- `review-mutation-build.txt`: successful client build in **1.43s**, with the existing chunk-size warning.
- `review-mutation-whitespace.txt`: `git diff --check`, exit 0 with no output.

No client/UI code changed in this correction, so no additional browser mutation was performed. Prior real Chrome overlap/connection evidence remains recorded above. Tests used controlled adapters and local/in-memory fixtures; there were no real gym writes, deployments, pushes or merges. Branch and all earlier uncommitted work were preserved.

Auto-Upgrade recheck final state: all checks above passed; tracked mock-booking fixtures are clean. No source changes followed verification, no new browser tab/process was opened for this worker-only correction, and the branch remains uncommitted for bounded review.
