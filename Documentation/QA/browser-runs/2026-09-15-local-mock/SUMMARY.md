# Browser Automation Summary — 2026-09-15-local-mock

## 1. Environment & Scope
- **Date**: 2026-09-15; resumed 2026-09-16
- **Lane**: Lane A (Local Mocks)
- **Node**: v20.19.0 (from `.nvmrc`)
- **Git Commit**: `8387d53dd21b1107c3a3cbba2238b399ba39b76c` (dirty worktree)
- **App Host**: `http://localhost:5173` (Vite dev) / `http://localhost:3000` (Node server)
- **Browser**: Google Chrome via `agent-browser` (session: `lane-a`), 1280x720, dark theme
- **Status**: Execution in progress; `AUTH-03` passed, `AUTH-03R` flagged QA-05 and QA-06

## 2. Results Summary by Priority
| Priority | PASS | FAIL | BLOCKED | DEFERRED | NOT RUN | Total |
|---|---|---|---|---|---|---|
| P0 | 5 (`GATE-01`, `GATE-03`, `AUTH-01`, `AUTH-02-R1`, `AUTH-03`) | 0 | 0 | 0 | 10 | 15 |
| P1 | 0 | 1 (`AUTH-03R`) | 0 | 0 | 13 | 14 |
| P2 | 0 | 0 | 0 | 0 | 5 | 5 |
| P3 | 0 | 0 | 0 | 0 | 3 | 3 |
| **Total** | **5** | **1** | **0** | **0** | **31** | **37** |

## 3. Detailed Findings by Priority

### P0 (Critical / Blocker)
- **QA-02 — resolved 2026-09-16**: CodexFit now has a non-production-only `dev@psycle.com` login path backed by `server/mock.js`. The focused zero-live-fetch regression passed, as did browser link and reload validation.
- **QA-03 — resolved 2026-09-16**: startup backfill now targets only legacy users with `password_hash IS NULL`. The disk-backed migration regression passed; a new gym-less browser account retained zero links and stayed authenticated through server restart.

### P1 (Primary User Goal / Security Boundary)
- **QA-06**: `setAuthMode('recover')` in `client/src/main.js:1275` throws an unhandled `TypeError: Cannot read properties of null (reading 'style')` on missing `#psycle-recover-step2`. This halts UI transition, leaves the footer switcher stuck on `"Create an account · Forgot password?"`, and omits the expected `"Back to log in"` link.

### P2 (Degraded UX / Copy Inconsistency)
- **QA-01**: Fresh gym-less account displays error toast `Failed to load filters metadata` and `Error: Failed to load bookings` on expected 409 `NO_GYM_LINKED` responses instead of graceful empty states.
- **QA-05**: Reset password screen subtitle displays legacy pre-2026-08-31 instructions (`"Confirm it’s you by signing in to a gym you’ve linked."`), contradicting the admin-assisted recovery policy and confusing users.

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
  - `screenshots/auth-03-pre-logout.png`: Pre-logout state showing linked Psycle credits & classes
  - `screenshots/auth-03-logged-out.png`: Post-logout clean login form
  - `screenshots/auth-03-logged-in-tabs.png`: Restored session across tabs
  - `screenshots/auth-03r-forgot-password.png`: Reset password card showing contradictory subtitle and broken switcher
  - `screenshots/auth-03r-back-to-login.png`: Restored clean login form

## 5. Release Recommendation
`DO NOT RELEASE` — QA-06 is a P1 runtime crash on the login/recovery surface.

## 6. Current Mechanical Verification — 2026-09-16
- Node: `v20.19.0`
- Server: 22/22 suites passed
- Client: 7 files, 64/64 tests passed
- Production client build: passed (26 modules transformed)
