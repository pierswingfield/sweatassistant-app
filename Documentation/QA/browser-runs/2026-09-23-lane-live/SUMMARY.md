# Browser Automation Summary — 2026-09-23-lane-live

## 1. Environment & Scope
- **Date**: 2026-09-23 / 2026-09-24
- **Lane**: Lane B (Live Provider Accounts)
- **Node**: `v20.19.0` (required for `better-sqlite3` native ABI)
- **Git Commit**: `8387d53dd21b1107c3a3cbba2238b399ba39b76c` (uncommitted modular multi-gym worktree)
- **App Host**: `http://localhost:5173` (Vite dev client) / `http://localhost:3000` (Express server)
- **Browser**: Google Chrome via `agent-browser` (session: `lane-live`), 1280x720 (with mobile 390x844 checks), dark theme
- **Account**: `test@piersj.com` (user ID 11), dual-linked to live JAB Boxing Club (`aiproscw@gmail.com`) and Psycle London (`aiproscw@gmail.com`)
- **Status**: Completed all approved live flows (`WIN-01` through `CLEAN-01`). External provider write mutations (`BOOK-01`–`BOOK-06`, `WAIT-01`–`WAIT-03`, `AU-01`–`AU-03`) were deferred due to 0 credits on Psycle and no active membership on JAB.

## 2. Results Summary by Priority
| Priority | PASS | FAIL | BLOCKED | DEFERRED | Total |
|---|---|---|---|---|---|
| **P0** | 3 (`GATE-01`, `GATE-02`, `GATE-03`) | 1 (`SET-05` / QA-22) | 0 | 0 | 4 |
| **P1** | 7 (`WIN-01`, `WIN-02`, `MAP-02`, `MAP-03`, `AB-01`, `AB-04`, `CLEAN-01`) | 2 (`WIN-04` / QA-16, `MAP-01` / QA-18) | 0 | 7 (`BOOK-01`, `BOOK-02`, `BOOK-03`, `BOOK-04`, `BOOK-05`, `BOOK-06`, `WAIT-01`) | 16 |
| **P2** | 4 (`MAP-04`, `AB-02`, `AB-03`, `SET-02`) | 2 (`NOTIF-01` / QA-20, `SET-01` / QA-21) | 0 | 4 (`WAIT-02`, `WAIT-03`, `AU-01`, `AU-02`) | 10 |
| **P3** | 2 (`CAL-01`, `SET-04`) | 0 | 0 | 1 (`AU-03`) | 3 |
| **Total** | **16** | **5** | **0** | **12** | **33** |

*(Note: QA-17 and QA-19 were identified during WIN-04 and MAP-04 code/DOM audits respectively).*

## 3. Detailed Findings by Priority

### P0 (Critical / Security Blocker)
- **QA-22 — DOM Exposure of Provider Credentials in Class Debug Modal (`SET-05`)**:
  In `client/src/ui/timetable.js:3451-3453`, `openDebugModal()` renders raw event JSON directly into the DOM via `<pre class="psycle-code-block">`. For Psycle London classes, CodexFit's raw organisation relations payload contains `"shopify_api_password"`, exposing live third-party API credentials in plaintext inside the browser client DOM. Must sanitize/redact sensitive keys (`*password*`, `*secret*`, `*key*`, `*token*`) on both the server adapter (`providers/codexfit.js`) and the client debug renderer (`timetable.js`).

### P1 (Primary User Goal / Architecture Defect)
- **QA-16 — Unmetered Gyms Render "Buy Credits" on Open Classes When Ineligible (`WIN-04`)**:
  In `client/src/ui/timetable.js:1463`, `buildActionModel()` falls into `if (!hasCredit)` and hardcodes the button label to `Buy Credits` (danger variant) for unmetered gyms when an account has no active membership (`/api/eligibility` returns `canBook: false`). Clicking it routes to Credits & Membership where JAB shows no credits and no purchase flow. Should render a membership-oriented prompt or disabled state.
- **QA-18 — Settings Spot Maps Modal Wrong-Gym Query & "Unknown Location" Grouping (`MAP-01`)**:
  In Settings > Your Gyms > JAB drawer > Manage maps, studios are grouped under "Unknown Location" because `cache.locations` from Psycle is reused (`settings.js:711`). In `settings.js:858`, clicking "Choose Spots" clobbers `options.gymId` with `studio.gymId` (which is `undefined`), querying the active gym (Psycle) instead of JAB. The query returns `{ slots: [] }` and falls back to "No floor map available".

### P2 (Degraded UX / Gym Neutrality Violations)
- **QA-17 — Header Gym Badge Falsely Displays "Member" Without Verifying Active Status (`WIN-04`)**:
  In `client/src/main.js:555-573`, `renderGymBadge()` checks `if (isMetered) ... else { ... badge.innerHTML = "Member"; }`. It assumes any unmetered gym implies active membership, ignoring `cache.eligibilityByGym[gymId]` and `/api/membership`.
- **QA-19 — My Bookings Renders Misleading "Spot ?" on First-Come-First-Serve Bookings (`MAP-04`)**:
  In `client/src/ui/bookings.js:203` and `233`, bookings without assigned seats (e.g. FCFS/Recovery classes) evaluate to null for all spot accessors and fall back to `'?'`, rendering `<button class="ab-spot-upgrade-chip ...">Spot ?</button>`.
- **QA-20 — Server Push Notification Titles and Templates Hardcode "Psycle:" (`NOTIF-01`)**:
  In `server/notifications.js`, notification builders (`buildBooking`, `buildUpgrade`, `buildCreditWarning`, `buildCancellationReminder`, `buildBookingWindow`) do not accept or read `ctx.gymId`. Live dispatches and debug samples unconditionally generate `"Psycle: Spot Booked"`, violating gym neutrality and WP-D7.

### P3 (Visual / Multi-Gym Copy Polish)
- **QA-21 — Settings > About Disclaimer Interpolates Only One Gym Name (`SET-01`)**:
  In `client/src/gym-context.js:71-77`, `applyGymName()` reads `state.name` (a single active gym name) rather than querying `getLinkedGyms()`. As a result, the About page reads: *"Sweat Assistant — an unofficial companion for JAB Boxing Club"*, omitting Psycle London entirely for multi-gym accounts.

## 4. Run Artifacts & Screenshots
- `CONTROL.md`: `Documentation/QA/browser-runs/2026-09-23-lane-live/CONTROL.md`
- `RUN_LOG.md`: `Documentation/QA/browser-runs/2026-09-23-lane-live/RUN_LOG.md`
- `ISSUES.md`: `Documentation/QA/browser-runs/2026-09-23-lane-live/ISSUES.md`
- 23 Screenshots captured in `Documentation/QA/browser-runs/2026-09-23-lane-live/screenshots/`:
  - `lane-live-authenticated-header.png`
  - `win-01-psycle-closed-class.png`, `win-01-psycle-open-class.png`, `win-01-jab-independence.png`
  - `win-02-jab-per-class-window.png`, `win-02-jab-autobook-banner.png`
  - `win-04-entitlement-psycle.png`, `win-04-entitlement-jab.png`
  - `map-01-psycle-ride-map.png`, `map-01-psycle-reformer-map.png`, `map-01-jab-boxing-map.png`, `map-01-jab-train-map.png`
  - `map-02-autobook-modal.png`, `map-02-settings-propagated.png`
  - `map-03-psycle-ride-autobook-modal.png`, `map-03-jab-boxing-autobook-modal.png`, `map-03-psycle-spot-editor-unaffected.png`
  - `map-04-fcfs-no-map-fallback.png`
  - `ab-01-jab-scheduled-card.png`, `ab-02-edited-card.png`, `ab-03-multi-gym-queue-ordering.png`
  - `notif-01-customise-modal.png`
  - `cal-01-calendar-settings.png`
  - `set-01-general.png`, `set-01-notifications.png`, `set-01-account.png`, `set-01-your-gyms.png`, `set-01-drawer-jab.png`, `set-01-drawer-psycle.png`, `set-01-about.png`
  - `set-02-credits-summary.png`
  - `set-04-profile-explorer-jab.png`, `set-04-profile-explorer-psycle.png`
  - `set-05-debug-modal-psycle.png`, `set-05-debug-modal-jab.png`
  - `clean-01-final-reconciliation.png`

## 5. Release Recommendation
`DO NOT RELEASE / DO NOT DEPLOY`:
1. **QA-22 (P0 - Security)**: `shopify_api_password` exposed in plaintext DOM when opening class debug diagnostics on Psycle classes. Must be redacted immediately.
2. **QA-18 (P1)**: Settings studio map editor broken for secondary gyms (queries Psycle instead of JAB).
3. **QA-16 & QA-17 (P1/P2)**: Unmetered gyms show misleading "Buy Credits" button and false "JAB Member" badge when membership is absent.
4. **QA-20 (P2)**: Server push notifications hardcode "Psycle:" for all gyms.

## 6. Reconciliation & State Verification
At the conclusion of `CLEAN-01`, the local SQLite database and browser state were fully verified:
- `auto_bookings`: 0
- `auto_upgrades`: 0
- `booking_cache`: 0
- `waitlist_cache`: 0
- `calendar_token`: null (disabled)
- `account_settings`: clean baseline (`autoBookPaused: false`, `debugMode: false`, `prefetchWeeks: 4`, JAB booking reminder `false`, Psycle `true`)
- `studio_preferences`: all 4 protected studio maps verified intact bit-for-bit
- All 5 app tabs verified clean and error-free in `agent-browser --session lane-live`.
