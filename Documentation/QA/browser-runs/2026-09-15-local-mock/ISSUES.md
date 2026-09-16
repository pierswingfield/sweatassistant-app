## QA-01 — Unlinked account displays error toast 'Failed to load filters metadata' and 'Error: Failed to load bookings' on 409 NO_GYM_LINKED

- Severity: P2
- Flow: AUTH-01 step 6 & step 8
- Environment/build: `http://localhost:5173` (Vite dev client) / `http://localhost:3000` (Server), v1.3.0, commit `8387d53dd21b1107c3a3cbba2238b399ba39b76c`
- Browser/device: agent-browser (Chromium), macOS, 1280x720, dark theme
- Persona/gym: Fresh (no gym linked)
- Frequency: 2/2 attempts (on signup completion and on subsequent page reload)
- Confidence: Confirmed
- Cleanup impact: None

### Preconditions
Freshly created Sweat Assistant account with zero linked gyms (`qa-fresh-1726435220@local.test`).

### Steps to reproduce
1. Create a fresh account or log into an account with no linked gyms.
2. Observe toasts and network requests as initial timetable and booking data load.
3. Reload page and inspect Timetable and My Bookings tabs.

### Expected
When no gym is linked, gym-scoped endpoints return 409 NO_GYM_LINKED as designed. The UI should recognise the 409 `NO_GYM_LINKED` status and suppress error toasts like "Failed to load filters metadata.", and render a graceful "Connect a gym to see your bookings" empty state in My Bookings rather than `Error: Failed to load bookings`.

### Actual
1. An error toast `❌ Failed to load filters metadata.` is displayed both after signup and after page reload.
2. In the "My Bookings" tab, both ACTIVE BOOKINGS and ACTIVE WAITLISTS sections display `Error: Failed to load bookings`.

### Evidence
- Screenshot: `screenshots/auth-01-no-gym-state.png` (captured error toast on top of connect dialog)
- Console:
  `[error] [Timetable] Metadata load failed: Error: Failed to load timetable metadata`
  `[error] [Timetable] Prefetch failed: Error: Failed to load bookings`
  `[error] [Bookings] Loading failed: Error: Failed to load bookings`
- Network:
  `GET /api/metadata` -> 409
  `GET /api/bookings` -> 409
  `GET /api/waitlists` -> 409
- Provider confirmation: not applicable (local mock lane, no-gym state)

### Scope and consistency checks
- Other gym affected: not applicable (no gym linked)
- Desktop/mobile: desktop viewport (1280x720)
- Light/dark: dark
- Fresh/warm cache: fresh cache
- Existing backlog match: none

### Notes
In `client/src/ui/timetable.js:299`, `loadFilterMetadata()` catches the 409 rejection and unselectively calls `showToast('Failed to load filters metadata.', 'error')`. Similarly in `client/src/ui/bookings.js:76`, `renderBookings()` catches 409 and injects error text into the section bodies. Both should check for `err.status === 409` or `err.code === 'NO_GYM_LINKED'` and handle gracefully.

## QA-02 — CodexFitProvider.login lacks dev-mode mock bypass for dev@psycle.com, blocking first gym link in local mock lane

- Severity: P0
- Flow: AUTH-02 step 4
- Environment/build: `http://localhost:5173` (Vite dev client) / `http://localhost:3000` (Server), commit `8387d53dd21b1107c3a3cbba2238b399ba39b76c`
- Browser/device: agent-browser (Chromium), macOS, 1280x720, dark theme
- Persona/gym: Fresh -> Psycle-only / Psycle London
- Frequency: 100% reproducible
- Confidence: Confirmed
- Cleanup impact: None

### Preconditions
Fresh Sweat Assistant account (`qa-fresh-1726435220@local.test`) logged in.

### Steps to reproduce
1. Open "Connect a gym" modal or advance to onboarding step 4 ("Connect your gym accounts").
2. Select "Psycle London", enter email `dev@psycle.com` and password `anypassword`.
3. Click "Link gym" (or "Connect Gym").

### Expected
In local mock lane, `dev@psycle.com` should link Psycle London using the dev mock provider (`server/mock.js`), mirroring `dev@jabboxing.mock` for MarianaTek (`server/providers/marianatek.js:127`).

### Actual
Request fails with HTTP 400 (`{ message: "Login failed with status 401" }`). `server/providers/codexfit.js:134` lacks a mock bypass in `login()` and issues a live POST request to `https://psyclelondon.com/api/v1/customer/auth/login`, which returns 401 Unauthorized.

### Evidence
- Network request: `POST http://localhost:5173/api/my-gyms/link` -> 400 Bad Request
- Response body: `{"message":"Login failed with status 401"}`
- Source comparison: `server/providers/marianatek.js:127` implements `if (email === DEV_EMAIL) return { session, profile ... }`, while `server/providers/codexfit.js:134` directly executes `await fetch(this.url(this.gym.loginPath), ...)`.

### Notes
`server/providers/codexfit.js` checks `if (token === MOCK_TOKEN)` in `request()`, but omits the mock bypass in `login({ email, password })`. Adding `if (email === 'dev@psycle.com')` to `codexfit.login()` returning a mock session and profile would align CodexFit with MarianaTek.

### Resolution — 2026-09-16
- Status: Resolved and locally validated.
- Change: `CodexFitProvider.login()` now routes `dev@psycle.com` through the existing CodexFit mock only when `NODE_ENV !== 'production'`. Production continues through the real provider login path.
- Regression coverage: `server/test-codexfit-mock-login.js` proves direct mock login and fresh-account `linkGymAccount()` make zero external fetches, and proves production does not return the mock sentinel.
- Mechanical verification: focused regression test passed; the full suite passed with 22/22 server suites and 64/64 client tests; the client production build passed.
- Browser verification: a fresh synthetic account linked Psycle with `dev@psycle.com`, displayed `Gym connected successfully!`, loaded the app with the linked Psycle account, and retained the link after reload.

## QA-03 — backfillUserGyms() in server/db.js unconditionally creates empty default-gym link rows on DB startup, violating D4 and causing 401 logout loops

- Severity: P0
- Flow: AUTH-02 step 9
- Environment/build: `http://localhost:5173` (Vite dev client) / `http://localhost:3000` (Server), commit `8387d53dd21b1107c3a3cbba2238b399ba39b76c`
- Browser/device: agent-browser (Chromium), macOS, 1280x720, dark theme
- Persona/gym: Fresh (unlinked account)
- Frequency: 100% reproducible on DB import / server restart
- Confidence: Confirmed
- Cleanup impact: Corrupts `user_gyms` table with unauthenticated default gym rows (`session_json: null`, `encrypted_password: ''`).

### Preconditions
User signed up via `createAccount()` with no gym linked.

### Steps to reproduce
1. Sign up a new user via `POST /api/auth/signup` (creates user with no `user_gyms` row).
2. Cause `server/db.js` to be imported (e.g. server restart, background task, test execution).
3. Observe `user_gyms` table for the user.
4. Attempt to log in or reload the client.

### Expected
A gym-less account remains gym-less until explicitly linked via `POST /api/my-gyms/link` (Decision D4). Gym-scoped requests return 409 `NO_GYM_LINKED`.

### Actual
`backfillUserGyms()` at top level of `server/db.js:393-417` iterates all users and inserts a row into `user_gyms` for `DEFAULT_GYM_ID` (`psycle-london`) with empty `encrypted_password` and `session_json: null`. On subsequent login, `api.getMyGyms()` sees 1 linked gym, client proceeds to `initApp()` and calls `api.getNormalizedProfile()`, server's `resolveContext` sees linked gym with null session, throws HTTP 401 ("No active session for this gym. Please log in."), and client's `apiFetch` catches 401 and forces an immediate logout loop.

### Evidence
- DB row created:
  `{ id: 35, user_id: 7, gym_id: 'psycle-london', encrypted_password: '', session_json: null, status: 'active', gym_email: 'qa-fresh-1726435220@local.test' }`
- Console log:
  `[warning] [API] Received 401. Session expired. Logging out.`
  `[error] [App] Failed to refresh user credentials: Your session has expired. Please log in again.`

### Notes
`backfillUserGyms()` was intended as a one-time migration for legacy pre-D4 users, but runs unconditionally on every module import against newly signed up gym-less users. It should only backfill users who don't have `password_hash` or should be guarded by a one-time migration schema flag.

### Resolution — 2026-09-16
- Status: Resolved and locally validated.
- Change: `backfillUserGyms()` now considers only legacy users whose `password_hash IS NULL`; D4 accounts with an independent Sweat Assistant password remain deliberately gym-less.
- Regression coverage: `server/test-backfill-user-gyms.js` reloads a disk-backed database and proves a D4 account remains unlinked while a genuine pre-D4 account receives the expected default Psycle migration row.
- Mechanical verification: focused regression test passed; the full suite passed with 22/22 server suites and 64/64 client tests; the client production build passed.
- Browser/data verification: a newly created gym-less account remained authenticated across a server restart, did not enter the former 401 logout loop, and retained exactly zero `user_gyms` rows. The app still mishandles the legitimate 409 no-gym response and can remain on `Loading...`; that separate presentation defect remains tracked as QA-01.

## QA-04 — Invalid gym credentials error message exposes generic HTTP status code instead of naming failing gym

- Severity: P3
- Flow: AUTH-02 step 3
- Environment/build: `http://localhost:5173` (Vite dev client) / `http://localhost:3000` (Server), commit `8387d53dd21b1107c3a3cbba2238b399ba39b76c`
- Browser/device: agent-browser (Chromium), macOS, 1280x720, dark theme
- Persona/gym: Fresh / Psycle London
- Frequency: 100% reproducible
- Confidence: Confirmed
- Cleanup impact: None

### Preconditions
Connect a gym modal or Onboarding gym step open.

### Steps to reproduce
1. Enter invalid email `invalid@psycle.com` and password `badpass` for Psycle London.
2. Click "Link gym" or "Connect Gym".

### Expected
Error message names the failing gym (e.g., "Could not log into Psycle London. Please check your email and password.") without leaking raw HTTP status codes or provider internals.

### Actual
Error banner displays raw message `"Login failed with status 401"`.

### Evidence
- Modal error text: `"Login failed with status 401"`
- Network response: `POST /api/my-gyms/link` -> 400 Bad Request `{"message":"Login failed with status 401"}`
