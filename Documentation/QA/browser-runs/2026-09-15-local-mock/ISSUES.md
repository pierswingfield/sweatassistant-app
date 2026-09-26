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

## QA-05 — Reset password screen subtitle contradicts admin-assisted recovery policy and displays legacy gym-login recovery instructions

- Severity: P2
- Flow: AUTH-03R steps 2 & 3
- Environment/build: `http://localhost:5173` (Vite dev client) / `http://localhost:3000` (Server), commit `8387d53dd21b1107c3a3cbba2238b399ba39b76c`
- Browser/device: agent-browser (Chromium), macOS, desktop viewport, dark theme
- Persona/gym: Fresh / unauthenticated
- Frequency: 100% reproducible
- Confidence: Confirmed
- Cleanup impact: None

### Preconditions
Login screen displayed at `http://localhost:5173`.

### Steps to reproduce
1. Click "Forgot password?".
2. Inspect the screen heading and subtitle.

### Expected
The screen immediately and accurately explains that self-service recovery is unavailable and that recovery is admin-assisted, without implying that a linked gym login controls account ownership or recovery.

### Actual
The subtitle displays: `"Confirm it’s you by signing in to a gym you’ve linked."`
This directly contradicts the notice under the Continue button (`"Self-service reset isn’t available yet — contact the admin."`), confusing users by referencing the retired pre-2026-08-31 gym-login recovery mechanism.

### Evidence
- Screenshot: `screenshots/auth-03r-forgot-password.png`
- Rendered text: Heading `Reset password`, subtitle `Confirm it’s you by signing in to a gym you’ve linked.`
- Source code: `client/src/main.js:1260` defines `recover:{ title: 'Reset password', subtitle: 'Confirm it’s you by signing in to a gym you’ve linked.' }`.

## QA-06 — setAuthMode('recover') throws unhandled TypeError on missing #psycle-recover-step2, breaking footer switcher and omitting 'Back to log in' link

- Severity: P1
- Flow: AUTH-03R steps 2 & 6
- Environment/build: `http://localhost:5173` (Vite dev client) / `http://localhost:3000` (Server), commit `8387d53dd21b1107c3a3cbba2238b399ba39b76c`
- Browser/device: agent-browser (Chromium), macOS, desktop viewport, dark theme
- Persona/gym: Fresh / unauthenticated
- Frequency: 100% reproducible
- Confidence: Confirmed
- Cleanup impact: None

### Preconditions
Login screen displayed at `http://localhost:5173`.

### Steps to reproduce
1. Click "Forgot password?".
2. Observe browser console errors.
3. Observe footer switcher links below the card.

### Expected
`setAuthMode('recover')` completes without JS runtime exceptions. `#psycle-auth-switcher` updates to show `<a href="#" id="psycle-auth-to-login">Back to log in</a>` so the user can easily return to the login form.

### Actual
`main.js:1275` attempts to execute:
`document.getElementById('psycle-recover-step2').style.display = 'none';`
Because `#psycle-recover-step2` was deleted from `index.html` during the recovery overhaul, `document.getElementById('psycle-recover-step2')` is `null`. The browser throws an uncaught exception:
`Uncaught TypeError: Cannot read properties of null (reading 'style')`
This unhandled error aborts `setAuthMode` before it can update `#psycle-auth-switcher` and call `wireAuthSwitcher()`. Consequently, the footer remains stuck showing `Create an account · Forgot password?` and the user cannot directly click "Back to log in" from the recovery card.

### Evidence
- Console error: `Uncaught TypeError: Cannot read properties of null (reading 'style')`
- DOM evaluation: `document.getElementById('psycle-auth-to-login')` is `null`.
- Screenshot: `screenshots/auth-03r-forgot-password.png` shows the bottom switcher unchanged from the login view.

## QA-07 — db.upsertUserGym() in server/db.js omits last_authenticated_at from SQL INSERT/UPDATE, leaving connection timestamp 'Not recorded'

- Severity: P2
- Flow: AUTH-06 steps 4 & 6
- Environment/build: `http://localhost:5173` (Vite dev client) / `http://localhost:3000` (Server), v1.3.0, commit `8387d53dd21b1107c3a3cbba2238b399ba39b76c`
- Browser/device: agent-browser (Chromium), macOS, desktop viewport, dark theme
- Persona/gym: Multi-gym / Psycle London & JAB Boxing Club
- Frequency: 100% reproducible
- Confidence: Confirmed
- Cleanup impact: None

### Preconditions
Sweat Assistant account with linked gyms (`qa-auth03-1726494160@local.test`).

### Steps to reproduce
1. Navigate to Settings > Your Gyms.
2. Click "Re-authenticate" on Psycle London (or any gym).
3. Enter valid gym credentials (`dev@psycle.com` / `anypassword`) and click "Re-authenticate".
4. Observe the toast notification ("Re-authenticated") and the "Last authenticated" column in the "Gym connections" table.

### Expected
The "Last authenticated" column should update to reflect the newly authenticated timestamp (e.g. `Today · 16 Sept 2026`).

### Actual
The "Last authenticated" column remains `Not recorded`.

### Evidence
- Screenshot: `screenshots/auth-06-reauth-success.png`
- API response: `GET /api/my-gyms` returns `"last_authenticated_at": null` for the re-authenticated gym row.
- Database row inspection: SQLite table `user_gyms` has column `last_authenticated_at` with value `null`, while `updated_at` was updated to `2026-09-16 13:55:33`.
- Source code analysis:
  In `server/auth.js:463` and `server/db.js:1132`, `last_authenticated_at` is passed to `db.upsertUserGym(userId, gymId, fields)`.
  However, in `server/db.js:1860-1872`:
  `upsertUserGym()` omits `last_authenticated_at` from both the `INSERT INTO user_gyms (...)` column list, the `ON CONFLICT(...) DO UPDATE SET ...` clause, and the `.run(...)` parameters.

### Scope and consistency checks
- Other gym affected: Affects all gyms upon link or re-authentication.
- Desktop/mobile: Both (backend database layer omission).
- Light/dark: Both.
- Fresh/warm cache: Both.
- Existing backlog match: none.

## QA-08 — Gym session expiration/failure returns HTTP 401, causing client apiFetch to log out the entire Sweat Assistant account instead of isolating degradation to the affected gym

- Severity: P0
- Flow: AUTH-07 steps 2, 3 & 4
- Environment/build: `http://localhost:5173` (Vite dev client) / `http://localhost:3000` (Server), v1.3.0, commit `8387d53dd21b1107c3a3cbba2238b399ba39b76c`
- Browser/device: agent-browser (Chromium), macOS, desktop viewport, dark theme
- Persona/gym: Reconnect / Multi-gym (JAB Boxing Club session degraded)
- Frequency: 100% reproducible
- Confidence: Confirmed
- Cleanup impact: None

### Preconditions
Sweat Assistant account with multiple gyms linked (`qa-auth03-1726494160@local.test` with Psycle London and JAB Boxing Club).

### Steps to reproduce
1. Induce an expired/invalid session on one gym in SQLite (or let session renewal fail naturally via `server/auth.js:369`):
   `UPDATE user_gyms SET status = 'needs_relogin', session_json = NULL WHERE user_id = 10 AND gym_id = 'jab-boxing';`
2. Reload the page at `http://localhost:5173` (or trigger background SWR/prefetch query for that gym).
3. Observe browser behavior, console, and network traffic.

### Expected
Per multi-gym isolation requirements and AUTH-07 specification:
"Expected: one provider failure degrades one gym, not the whole account."
The unaffected gym (Psycle London) continues to load normally, while the affected gym (JAB Boxing Club) displays a "Reconnect needed" warning banner and an actionable "Re-authenticate" control in Settings > Your Gyms. The user remains authenticated in Sweat Assistant.

### Actual
1. The server routes (`server/routes-normalized.js:88-92`) check `if (!user || !user.jwt)` for gym-scoped calls (e.g. `GET /api/credits?gymId=jab-boxing`) and throw HTTP 401 (`{ message: "No active session for this gym. Please log in." }`).
2. The client global fetch handler (`client/src/api.js:100-106`) intercepts ANY HTTP 401 response and assumes the global Sweat Assistant account session has expired:
   ```javascript
   if (res.status === 401 && localToken) {
     console.warn('[API] Received 401. Session expired. Logging out.');
     setToken(null);
     window.dispatchEvent(new CustomEvent('psycle-logout-triggered'));
     throw new Error('Your session has expired. Please log in again.');
   }
   ```
3. This unceremoniously strips `psycleLocalToken`, dispatches `psycle-logout-triggered`, and forces the entire application to log out back to the `#psycle-login-container` login screen.
4. If the user attempts to log back in, background SWR queries for the degraded gym trigger the exact same 401 and immediately log the user out again, creating an inescapable logout loop.
5. The unaffected gym is completely inaccessible, and the user cannot access the "Re-authenticate" button in Settings.

### Evidence
- Screenshots:
  - `screenshots/auth-07-degraded-gym-logout-bug.png` (shows forced eviction to login screen when `session_json = null` is induced)
  - `screenshots/auth-07-degraded-gym.png` (shows desired UI rendering when `session_json` is not null but `status = 'needs_relogin'`)
  - `screenshots/auth-07-recovered-gym.png` (shows successful reauth recovery with dual badges)
- Console log:
  `[warning] [API] Received 401. Session expired. Logging out.`
  `[warning] [Cache] Background refresh failed for /api/credits?gymId=jab-boxing: Error: Your session has expired. Please log in again.`
- Network request/response:
  `GET http://localhost:3000/api/credits?gymId=jab-boxing` -> HTTP 401 Unauthorized
  `{"message":"No active session for this gym. Please log in."}`
- Source code analysis:
  - In `server/routes-normalized.js:88-92`, `resolveContext()` sets `err.status = 401` when `!user.jwt`. This conflates a gym provider session expiration with a Sweat Assistant account JWT expiration.
  - In `client/src/api.js:100-106`, `apiFetch()` fails to distinguish between account-level auth failures (`/api/auth/*`) and per-gym provider failures (`/api/credits?gymId=...`, `/api/bookings?gymId=...`).

### Scope and consistency checks
- Other gym affected: Yes, one gym's session failure nukes access to all other healthy gyms.
- Desktop/mobile: Both viewports.
- Light/dark: Both themes.
- Fresh/warm cache: Both.
- Existing backlog match: Closely related to QA-03 (which fixed unlinked-gym 401 loops via 409 NO_GYM_LINKED, but did not address linked-gym provider session expiration).

## QA-09 — Unlinking or relinking a gym does not update in-memory gym context, header badges, or Credits tab until page reload

- Severity: P2
- Flow: AUTH-08 steps 5, 7, 8
- Environment/build: `http://localhost:5173` (Vite dev client) / `http://localhost:3000` (Server), commit `8387d53dd21b1107c3a3cbba2238b399ba39b76c`
- Browser/device: agent-browser (Chromium), macOS, desktop, dark theme
- Persona/gym: Multi-gym / JAB Boxing Club, Psycle London
- Frequency: 100% reproducible
- Confidence: Confirmed
- Cleanup impact: None

### Preconditions
User logged into multi-gym account with both Psycle London and JAB Boxing Club linked.

### Steps to reproduce
1. Navigate to Settings > Your Gyms.
2. Double-click "Unlink" on JAB Boxing Club.
3. Observe "Gym unlinked." toast and removal from Settings connection table and sidebar.
4. Check the top header credit/membership badges and the Credits & Membership tab.
5. In Settings > Your Gyms, click "＋ Connect a gym" and relink JAB Boxing Club (`dev@jabboxing.mock` / `anypassword`).
6. Check the top header badges again.

### Expected
1. Unlinking a gym immediately updates client-side gym context: the unlinked gym's header badge ("JAB Member") disappears, and the Credits tab removes that gym's membership card without requiring a page reload.
2. Relinking a gym immediately updates the in-memory gym context and header badges without requiring a page reload.
3. The UI warns the user before unlinking that gym-specific data (e.g. spot preferences, release queues, upgrade monitors) will be permanently wiped.

### Actual
1. `renderGymsCard()` in `client/src/ui/settings.js:1211-1213` executes `await api.unlinkGym(gymId); showToast('Gym unlinked.', 'success'); await renderGymsCard();`. It only re-fetches `api.getMyGyms()` and rebuilds the Settings connection table and sidebar.
2. It does not update in-memory `linkedGyms` in `client/src/gym-context.js` (via `setLinkedGyms()`), does not refresh `cache.creditsByGym`, and does not call `updateCreditBadge()`.
3. Consequently, in the SPA:
   - The top header banner continues displaying "JAB Member" badge after unlinking until a full page reload occurs.
   - The Credits & Membership tab (`client/src/ui/credits.js:49`) reads `getLinkedGyms()` from `gym-context.js` and continues rendering the unlinked gym's membership card until a full page reload occurs.
   - Similarly, upon relinking via "＋ Connect a gym", `updateCreditBadge()` is not triggered, leaving the newly linked gym's badge missing from the header until reload.
4. The Unlink button transitions from "Unlink" to "Confirm unlink?" on first click, but contains no confirmation modal or helper copy indicating that spot maps, release queues, and upgrade monitors for that gym will be permanently deleted in SQLite (per `server/db.js:1913-1921`).

### Evidence
- Screenshots:
  - `screenshots/auth-08-unlink-confirm.png` (shows "Confirm unlink?" button state)
  - `screenshots/auth-08-gym-unlinked.png` (shows timetable filtered to Psycle, but "JAB Member" header badge still present)
  - `screenshots/auth-08-relinked-gym.png` (shows relinked JAB in table/sidebar, but header badge still missing until reload)
- Code analysis:
  - `client/src/ui/settings.js:1211-1213`: `unlinkGym` flow lacks calls to update `gym-context.js` and header badges.
  - `client/src/main.js:847`: `setLinkedGyms()` is only called inside `refreshUserData()` during initial load/app init.

### Scope and consistency checks
- Other gym affected: Yes, any multi-gym unlink or relink leaves stale in-memory state in client navigation.
- Desktop/mobile: Both viewports.
- Light/dark: Both themes.
- Fresh/warm cache: Both.

## QA-10 — About pane copy hardcodes single gym name rather than neutral multi-gym companion copy when multiple gyms are connected

- Severity: P3
- Flow: SET-01 step 6
- Environment/build: `http://localhost:5173` (Vite dev client) / `http://localhost:3000` (Server), commit `8387d53dd21b1107c3a3cbba2238b399ba39b76c`
- Browser/device: agent-browser (Chromium), macOS, desktop, dark theme
- Persona/gym: Multi-gym / Psycle London & JAB Boxing Club
- Frequency: 100% reproducible
- Confidence: Confirmed
- Cleanup impact: None

### Preconditions
User logged in with multiple gyms linked (both Psycle London and JAB Boxing Club).

### Steps to reproduce
1. Navigate to Settings > About.
2. Read the heading, subtitle, and "What is this?" section copy.

### Expected
Per multi-gym neutrality requirements:
"Inspect About copy for gym neutrality: it must not describe a JAB user as a Psycle/CodexFit user or imply that every Auto-Book opens Monday noon."
When multiple gyms are connected, the app should refer to the user's gyms collectively (e.g. "an unofficial companion for your gyms") rather than picking one gym arbitrarily.

### Actual
The subtitle displays:
`"Sweat Assistant — an unofficial companion for JAB Boxing Club, built for personal use."`
The "What is this?" section displays:
`"Sweat Assistant is an unofficial personal tool — not affiliated with or endorsed by JAB Boxing Club. It uses your own gym login to interact with the same API that powers that gym's own booking site."`
`applyGymName()` in `client/src/gym-context.js` replaces `[data-gym-name]` with the first or active gym's name, which in a multi-gym context gives the false impression that the entire app is exclusively a companion for JAB Boxing Club, ignoring Psycle London.

### Evidence
- Screenshot: `screenshots/set-01-about-neutrality.png`
- Rendered text: `"Sweat Assistant — an unofficial companion for JAB Boxing Club, built for personal use."`

## QA-11 — GET /api/bundles returns empty bundles list in dev mock environment due to response envelope mismatch between mock.js and codexfit.js

- Severity: P2
- Flow: SET-02 step 3
- Environment/build: `http://localhost:5173` (Vite dev client) / `http://localhost:3000` (Server), commit `8387d53dd21b1107c3a3cbba2238b399ba39b76c`
- Browser/device: agent-browser (Chromium), macOS, desktop, dark theme
- Persona/gym: Multi-gym / Psycle London & JAB Boxing Club (dev@psycle.com)
- Frequency: 100% reproducible in dev mock environment
- Confidence: Confirmed
- Cleanup impact: None

### Preconditions
User logged in with Psycle London mock account (`dev@psycle.com`).

### Steps to reproduce
1. Navigate to Credits & Membership tab (`#credits`).
2. Click "Buy credits →" under Psycle London or open `#buy-credits`.
3. Observe bundle grid and category filter pills.

### Expected
The 3 mock Psycle bundles defined in `server/mock.js` ("CRM 5-Pack Ride Credits", "Introductory 3-Pack All Studios", "10-Pack Strength & Barre") render with their prices, credit quantities, and descriptions, allowing category filtering and search.

### Actual
The bundle container displays:
`"No bundles match the current filters."`
Even when searching or toggling all category checkboxes, no bundles appear.
Calling `GET /api/bundles` returns `{"bundles":[]}`.

### Root cause
In `server/providers/codexfit.js:798-801`:
```javascript
const data = await res.json().catch(() => ({}));
return {
  bundles: data.data || [],
  bundleTypes: (data.relations && data.relations.bundle_types) || undefined,
};
```
CodexFit's production API wraps responses in a by-reference envelope `{ data: [...], relations: { ... } }`.
However, `server/mock.js:286-288` returns the raw mock array:
```javascript
if (pathName.startsWith('/bundles')) {
  return createFakeResponse(bundles);
}
```
Because `bundles` is an Array rather than an object with a `data` property, `data.data` evaluates to `undefined`, causing `provider.listBundles()` to return `{ bundles: [] }`.

### Evidence
- Screenshot: `screenshots/set-02-psycle-bundles.png`
- Direct browser API eval: `GET /api/bundles` with `x-gym-id: psycle-london` returns `{"bundles":[]}`.
- Source code: `server/mock.js:287` vs `server/providers/codexfit.js:800`.

## QA-12 — Toggling Debug Mode in Settings > General does not dynamically show or hide the debug terminal without page reload or new log event

- Severity: P3
- Flow: SET-05 steps 2 & 5
- Environment/build: `http://localhost:5173` (Vite dev client) / `http://localhost:3000` (Server), commit `8387d53dd21b1107c3a3cbba2238b399ba39b76c`
- Browser/device: agent-browser (Chromium), macOS, desktop (1280x720), dark theme
- Persona/gym: Multi-gym / Psycle London & JAB Boxing Club (`qa-auth03-1726494160@local.test`)
- Frequency: 100% reproducible
- Confidence: Confirmed
- Cleanup impact: None

### Preconditions
User logged in with multi-gym account, navigating to Settings > General.

### Steps to reproduce
1. Navigate to Settings > General (`#settings`).
2. Toggle the "Debug Mode" switch (`#psycle-setting-debug-mode`) from OFF to ON.
3. Observe the bottom of the viewport for `#psycle-debug-terminal`.
4. Toggle the "Debug Mode" switch from ON to OFF.
5. Observe `#psycle-debug-terminal`.

### Expected
Toggling the switch ON immediately displays `#psycle-debug-terminal` (`display: block`). Toggling the switch OFF immediately hides `#psycle-debug-terminal` (`display: none`).

### Actual
When toggled ON, `#psycle-debug-terminal` remains at `display: none` until either the page is manually reloaded or a function explicitly triggers `debugLog()`. When toggled OFF, `#psycle-debug-terminal` remains at `display: block` until the page is manually reloaded.

### Root cause
In `client/src/ui/settings.js:1760-1778`:
```javascript
  const saveSettings = async () => {
    const newSettings = {
      debugMode: debugMode ? debugMode.checked : false,
      prefetchWeeks: prefetchWeeks ? parseInt(prefetchWeeks.value) : 4
    };

    try {
      await api.updateSettings(newSettings);
      Object.assign(userSettings, newSettings);
      updateTestNotifCardVisibility();
      renderGymSettingsSection().catch(() => {});
      showToast('Settings saved successfully.', 'success');
    } catch (err) {
      showToast(`Error saving settings: ${err.message}`, 'error');
    }
  };
```
`saveSettings` updates `userSettings` and calls `updateTestNotifCardVisibility()`, but never calls `updateDebugTerminalVisibility()`, which resides in `client/src/main.js` and is not imported in `settings.js`.

### Evidence
- Screenshots: `screenshots/set-05-debug-terminal.png`, `screenshots/set-05-psycle-diagnostics.png`, `screenshots/set-05-simulate-release.png`
- DOM inspection: checking the switch did not alter `psycle-debug-terminal.style.display` until reload; unchecking left `style.display = 'block'`.
- Source code: `client/src/ui/settings.js:1771-1774` omits `updateDebugTerminalVisibility()`.

## QA-13 — timetable.js coerces slot IDs via Number(slot.id), converting string IDs to NaN for MarianaTek / JAB and breaking spot selection in booking modal

- Severity: P1
- Flow: TT-04 step 3
- Environment/build: `http://localhost:5173` (Vite dev client) / `http://localhost:3000` (Server), commit `8387d53dd21b1107c3a3cbba2238b399ba39b76c`
- Browser/device: agent-browser (Chromium), macOS, desktop (1280x720), dark theme
- Persona/gym: Multi-gym / JAB Boxing Club (`qa-auth03-1726494160@local.test` / `dev@jabboxing.mock`)
- Frequency: 100% reproducible on any class with string slot IDs
- Confidence: Confirmed
- Cleanup impact: None

### Preconditions
User logged in with multi-gym account, navigating to Class Timetable (`#class-timetable`).

### Steps to reproduce
1. Navigate to Class Timetable tab (`#class-timetable`).
2. On any JAB Boxing Club row (e.g. 18:30 `BOXING Core & Power`, event 9004), click More actions ("⋯") and select "Book (choose a spot)".
3. In the floor plan modal, click on any available green spot bubble (e.g. "B1" or "G1").
4. Observe the spot bubble and the preferred spots summary below the floor plan.

### Expected
The clicked spot highlights with active styling (purple background, white priority number "1"), and the summary displays `PREFERRED SPOTS B1`.

### Actual
The spot bubble remains unselected (green background, "B1" label).
The summary text below the floor plan displays:
`PREFERRED SPOTS NaN`
Inspecting internal state reveals `state.selectedSlots` holds `[NaN]`.

### Root cause
In `client/src/ui/timetable.js:2440, 2465-2466, 2629, 2748`:
```javascript
// Line 2629:
const slotId = Number(slot.id);
```
MarianaTek (JAB Boxing) provides string slot IDs (e.g. `"mock-bag-1"`, `"mock-bag-2"`, or provider alphanumeric IDs). Coercing them via `Number(slot.id)` evaluates to `NaN`.
Because `NaN === NaN` evaluates to `false` in JavaScript:
1. `state.selectedSlots.indexOf(slotId)` always returns `-1`.
2. `const priority = state.selectedSlots.indexOf(slotId) + 1` evaluates to `0`, so `priority > 0` check fails and the bubble is never styled as selected.
3. In `summaryEl`, `state.selectedSlots.map(id => ... slot?.label || String(id))` fails to match `id` and falls back to `String(NaN)` (`"NaN"`).
4. Submitting booking would dispatch `[NaN]` as slot IDs to `api.book()`.

This mirrors root cause 3 previously identified and resolved in `poller.js` (`Documentation/Backlog/modular-gyms/PROGRESS.md:120`), where string slot IDs were broken by `Number(slotId)`. The client should preserve slot IDs as strings or use gym-safe comparisons as done in `client/src/ui/bookings.js:532` (`const slotId = String(slot.id)`).

### Evidence
- Screenshot: `screenshots/tt-04-jab-spotmap.png` (displays `PREFERRED SPOTS NaN` under JAB SW1 studio floor plan)
- Source code: `client/src/ui/timetable.js:2465-2466`, `client/src/ui/timetable.js:2629`, `client/src/ui/timetable.js:2748`

## QA-14 — Auto-Book tab omits Favourites button/section; openFavouritesModal() is orphaned dead code

- Severity: P2
- Flow: TT-05 step 4
- Environment/build: `http://localhost:5173` (Vite dev client) / `http://localhost:3000` (Server), commit `8387d53dd21b1107c3a3cbba2238b399ba39b76c`
- Browser/device: agent-browser (Chromium), macOS, desktop (1280x720), dark theme
- Persona/gym: Multi-gym / Psycle London (`qa-auth03-1726494160@local.test` / `dev@psycle.com`)
- Frequency: 100% reproducible
- Confidence: Confirmed
- Cleanup impact: None

### Preconditions
User logged in with bookmarked class on Psycle London, navigating to Auto-Book tab (`#auto-book`).

### Steps to reproduce
1. On Class Timetable, bookmark a Psycle class (e.g. Wednesday 21:30 Recovery 30).
2. Navigate to Auto-Book tab (`#auto-book`).
3. Attempt to locate or open the "Favourites" section to view or manage bookmarked classes.

### Expected
The Auto-Book tab provides a "Favourites" section or banner control allowing users to inspect and manage their bookmarked favourite classes, as documented in `client/index.html:309` (`<!-- Pause / Favourites / Simulate controls injected here by renderAutoBookControls -->`).

### Actual
The Auto-Book controls bar (`#psycle-autobook-controls-bar`) only renders `Pause Auto-Book` (and `Simulate Release` in debug mode). There is no "Favourites" button, link, or section in the DOM.

### Root cause
In commit `8ffec409d0b24c201607dcfe935c72776be69145` (`feat(ui): bookings redesign...`), `renderAutoBookControls()` was refactored and the Favourites button (`bar.appendChild(favsBtn)`) was removed from the bar. However, the modal implementation `openFavouritesModal()` was retained in `client/src/ui/autobook.js:239-320` as orphaned, uninvoked code. Users have no UI access to Auto-Book Favourites.

### Evidence
- Screenshot: `screenshots/tt-05-autobook-favourites.png` (displays Auto-Book banner containing only Pause button; Favourites missing)
- DOM inspection: `document.getElementById('psycle-autobook-controls-bar').innerHTML` contains only `<button class="ab-footer-btn">...<span>Pause Auto-Book</span></button>`
- Source code: `client/src/ui/autobook.js:156-211` omits Favourites button; `client/index.html:309` comments `<!-- Pause / Favourites / Simulate controls injected here by renderAutoBookControls -->`.

## QA-15 — Auto-Book Favourites modal copy promises unattended recurring weekly scheduling that scheduler.js does not perform

- Severity: P2
- Flow: TT-05 step 4 & step 5
- Environment/build: `http://localhost:5173` (Vite dev client) / `http://localhost:3000` (Server), commit `8387d53dd21b1107c3a3cbba2238b399ba39b76c`
- Browser/device: agent-browser (Chromium), macOS, desktop (1280x720), dark theme
- Persona/gym: Multi-gym / Psycle London (`qa-auth03-1726494160@local.test` / `dev@psycle.com`)
- Frequency: 100% reproducible
- Confidence: Confirmed
- Cleanup impact: None

### Preconditions
User with bookmarked classes opens the Auto-Book Favourites modal.

### Steps to reproduce
1. In `client/src/ui/autobook.js:239`, invoke `openFavouritesModal()`.
2. Inspect the prompt copy, empty state copy, and rendered bookmark metadata.
3. Check a favourite and click "Save Favourites".
4. Check the server auto-book queue and `server/scheduler.js`.

### Expected
The UI should accurately describe what the system does without falsely promising unattended recurring weekly auto-booking that the background scheduler does not execute. It should also display complete class metadata (class name, instructor, gym brand).

### Actual
1. The modal displays copy promising weekly automated booking:
   - Header prompt: `Select which favourites to auto-book each week:`
   - Empty state: `Bookmark classes from the timetable to set up recurring auto-book.`
2. Saving favourites persists `autoBookFavourites` to user settings via `PUT /api/settings`, but `server/scheduler.js` never reads or processes `autoBookFavourites` (documented as incomplete in `AGENTS.md:281`). No recurring queue entries are ever created.
3. The rendered list in `openFavouritesModal` only formats raw bookmark keys (`{studioId}0000{dayOfWeek}0000{HHMM}`) into `Studio <studioId> · <dayOfWeek> <time>` (e.g. `Studio 143 · Wed 21:30`), omitting class name, instructor name, and gym identity.

### Evidence
- Screenshot: `screenshots/tt-05-autobook-favourites.png`
- Codebase reference: `AGENTS.md:281` ("The Auto-Book tab has a '♥ Auto-Book Favourites' modal that saves autoBookFavourites... but nothing in scheduler.js consumes this list to auto-create queue entries each week.")
- Source code: `client/src/ui/autobook.js:257, 262, 279-281`


