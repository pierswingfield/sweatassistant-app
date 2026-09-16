# Browser Automation Summary — 2026-09-15-local-mock

## 1. Environment & Scope
- **Date**: 2026-09-15
- **Lane**: Lane A (Local Mocks)
- **Node**: v20.19.0 (from `.nvmrc`)
- **Git Commit**: `8387d53dd21b1107c3a3cbba2238b399ba39b76c` (dirty worktree)
- **App Host**: `http://localhost:5173` (Vite dev) / `http://localhost:3000` (Node server)
- **Browser**: Google Chrome via `agent-browser` (session: `lane-a`), 1280x720, dark theme
- **Status**: RESUMED / LOCAL MOCKS UNBLOCKED after `AUTH-02` remediation on 2026-09-16

## 2. Results Summary by Priority
| Priority | PASS | FAIL | BLOCKED | DEFERRED | NOT RUN | Total |
|---|---|---|---|---|---|---|
| P0 | 4 (`GATE-01`, `GATE-03`, `AUTH-01`, `AUTH-02-R1`) | 0 | 0 | 0 | 11 | 15 |
| P1 | 0 | 0 | 0 | 0 | 14 | 14 |
| P2 | 0 | 0 | 0 | 0 | 5 | 5 |
| P3 | 0 | 0 | 0 | 0 | 3 | 3 |
| **Total** | **4** | **0** | **0** | **0** | **33** | **37** |

## 3. Detailed Findings by Priority

### P0 (Critical / Blocker)
- **QA-02 — resolved 2026-09-16**: CodexFit now has a non-production-only `dev@psycle.com` login path backed by `server/mock.js`. The focused zero-live-fetch regression passed, as did browser link and reload validation.
- **QA-03 — resolved 2026-09-16**: startup backfill now targets only legacy users with `password_hash IS NULL`. The disk-backed migration regression passed; a new gym-less browser account retained zero links and stayed authenticated through server restart.

### P2 (Degraded UX / Accessibility)
- **QA-01**: Fresh gym-less account displays error toast `Failed to load filters metadata` and `Error: Failed to load bookings` on expected 409 `NO_GYM_LINKED` responses instead of graceful empty states.

### P3 (Visual / Copy Polish)
- **QA-04**: Invalid gym credentials error message exposes generic `"Login failed with status 401"` rather than naming the failing gym.

## 4. Run Artifacts & Screenshots
- `CONTROL.md`: `Documentation/QA/browser-runs/2026-09-15-local-mock/CONTROL.md`
- `RUN_LOG.md`: `Documentation/QA/browser-runs/2026-09-15-local-mock/RUN_LOG.md`
- `ISSUES.md`: `Documentation/QA/browser-runs/2026-09-15-local-mock/ISSUES.md`
- Screenshots captured:
  - `screenshots/gate-03-initial-load.png`: Clean initial landing view and onboarding intro
  - `screenshots/auth-01-no-gym-state.png`: Authenticated no-gym / connect modal state
  - `screenshots/auth-02-connect-modal.png`: Connect a gym modal with gym dropdown options

## 5. Release Recommendation
`CONTINUE LANE A TESTING` — QA-02 and QA-03 no longer block local mock execution. This is not release acceptance: 33 planned flows remain unrun, QA-01 and QA-04 remain open, and live-provider validation is still outstanding.

## 6. Current Mechanical Verification — 2026-09-16
- Node: `v20.19.0`
- Server: 22/22 suites passed
- Client: 7 files, 64/64 tests passed
- Production client build: passed (26 modules transformed)
