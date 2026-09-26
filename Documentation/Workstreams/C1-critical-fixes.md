# C1 — Critical fixes (security, session, data safety)

**Priority:** P0 · **Size:** ~1 day · **Depends on:** nothing · **Blocks:** C4 launch

> **Verify first:** before changing anything for an item, confirm its basis in the code **and**, for anything user-visible, **in a real browser** (CDP :9222 or Claude for Chrome). For server-only items, use a failing test or a request. Record the evidence. If a browser check is needed and no browser is available, stop with `BLOCKED`. See [AGENT_PROTOCOL.md](AGENT_PROTOCOL.md).

Small, independent fixes. Each one is a real risk to users or data, not polish.

| # | Item | Evidence (verified 2026-09-26) | Est. |
|---|---|---|---|
| C1-1 | ✅ **Redact credentials in the event debug modal.** It `JSON.stringify`s raw event, booking and waitlist payloads with HTML-escaping only. Add a redaction pass for tokens, keys, emails and payment fields. [QA-22] | `client/src/ui/timetable.js` `openDebugModal` | 1–2 h |
| C1-2 | ✅ **One gym's 401 must not log out the whole app.** `apiFetch` treats any 401, including a single provider's, as a Sweat Assistant session expiry: it clears the SA token and fires logout. Route per-gym 401s to that gym's "needs relogin" state instead. [QA-08] | `client/src/api.js` ~L100–106 | 2–3 h |
| C1-3 | ✅ **Keep slot IDs as strings in spot selection.** `Number(slot.id)` breaks non-numeric IDs (MarianaTek) and any ID over 2^53. [QA-13] | `client/src/ui/timetable.js` ~L2629 | 30 min |
| C1-4 | ✅ **Fix the crash in the account-recover screen.** `setAuthMode('recover')` references a `#psycle-recover-step2` element that doesn't exist, so it throws a TypeError. Also fix the subtitle, which still describes the removed gym-login recovery (belongs with U1-4, same lines). [QA-06, QA-05] | `client/src/main.js` ~L1260, L1275 | 30 min |
| C1-5 | **Back up the SQLite DB.** No backup job exists for prod or dev. The DB holds encrypted gym credentials, and it is only snapshotted by hand before deploys. Add a nightly job that copies `.db` **plus `-wal`/`-shm`**, or runs `sqlite3 .backup`, off the host (rclone → Drive, as the other services do). | No `scripts/`; nothing in `docker-compose.yml`. The registry notes manual `.bak` copies only. | 1–2 h |

## C1-1 — done 2026-09-26

**Root cause:** `openDebugModal` (`client/src/ui/timetable.js`) rendered `escapeHtml(JSON.stringify(jsonData, null, 2))` for the event/booking/waitlist tabs, where `jsonData` includes the provider's `.raw` payload verbatim. HTML-escaping prevents XSS but does nothing to hide a token/key/password/email/payment field that happens to be present in a gym's raw response — and per AGENTS.md WP-D7, no gym's raw shape is a contract this app controls.

**Fix:** `client/src/redact.js` (new) — `redactSensitivePayload(value)`, a pure deep-clone-and-blank function matched against a deliberately narrow, tokenized key-name set (tokens/keys/passwords/emails/payment fields only — not "session"/"cookie", which would have swept up legitimate raw fields like MarianaTek's `class_session_type`). Wired in at `client/src/ui/timetable.js:3596` — `JSON.stringify(redactSensitivePayload(jsonData), null, 2)`.

**Test added:** `client/src/redact.test.js` (7 cases: top-level token, nested/camelCase/snake_case variants, arrays, near-miss substrings left alone, null/undefined preserved, circular refs, non-mutation).

**Real-browser evidence** (CDP :9222, real Chrome, `npm run dev` local mock): intercepted `GET /api/events/999` via Playwright `page.route()` to return a crafted event with `raw.access_token`, `raw.user.email`, `raw.user.card_number`, `raw.user.cvv`, then called the real exported `openDebugModal()`.
- **Before** (redaction call temporarily reverted): rendered modal body contained the raw token, email and card number verbatim; no `[redacted]` marker.
- **After** (fix restored): none of the raw secrets appear in the rendered HTML; `[redacted]` markers present; non-sensitive fields (`discipline: "Ride"`) still render normally.
- Screenshots: `c11_before.png`, `c11_after.png` in the session scratchpad.

## C1-2 — done 2026-09-26

**Root cause:** the server has exactly one authenticated-request 401 today — `routes-normalized.js resolveContext()` (and a failed `auth.js triggerAutoRelogin()`) reporting that **one linked gym's own session** is dead. An invalid/expired Sweat Assistant JWT is a 403 from `auth.js authenticateToken` (`jwt.verify` failure), a completely different path. `client/src/api.js apiFetch`'s 401 handler didn't know this and treated the gym-session 401 as the SA session expiring: it cleared the local JWT and fired `psycle-logout-triggered` — logging out a two-gym account the instant *either* gym's credential went stale, even though the SA account and the other gym were both fine.

**Fix (server):** `server/routes-normalized.js resolveContext()` and both throw sites in `server/auth.js triggerAutoRelogin()` now tag the error with `err.code = 'GYM_SESSION_EXPIRED'` and `err.gymId`; `handleError()` forwards both into the JSON body alongside the existing `status`/`message`. **Fix (client):** new pure module `client/src/auth-failure.js` — `classifyAuthFailure(status, body, targetGym)` returns `{ kind: 'gym', gymId }` for a `GYM_SESSION_EXPIRED`-coded 401, else `{ kind: 'sa' }`. `client/src/api.js apiFetch` calls it and only clears the SA token / fires the whole-app logout for `kind: 'sa'`; for `kind: 'gym'` it dispatches `psycle-gym-needs-relogin` and returns the response untouched for the caller to handle. `client/src/main.js` listens for that event, toasts the gym by name (`getGymShortName`), and refreshes the "Your Gyms" card (`renderGymsCard()`) if Settings is mounted.

**Test added:** `client/src/auth-failure.test.js` (5 cases covering the routing decision directly, pure — no DOM/fetch mocking needed).

**Real-browser evidence** (CDP :9222, real Chrome, `npm run dev`, `dev@psycle.com` + linked `jab-boxing` via `dev@jabboxing.mock`): cleared `user_gyms.session_json`/`encrypted_password` for the JAB link directly in the dev SQLite DB, then hit `/api/profile` with `x-gym-id: jab-boxing` through the real `apiFetch()`.
- Raw server response: `{"status":401,"body":{"message":"No active session for this gym. Please log in.","code":"GYM_SESSION_EXPIRED","gymId":"jab-boxing"}}`.
- Through the app's real code path: `psycle-gym-needs-relogin` fired (not `psycle-logout-triggered`); `localStorage.psycleLocalToken` remained set; a toast rendered "JAB: session expired. Reconnect it in Settings → Your Gyms."; a parallel request for `psycle-london` in the same session returned 200 OK — the other gym and the SA session were both unaffected.
- DB state restored afterwards (re-linked JAB via `POST /api/my-gyms/link`, same as a user reconnecting).

## C1-3 — done 2026-09-26

**Root cause:** `client/src/ui/timetable.js` `openBookingModal` (the shared floor-plan spot-selection modal for Book/Quick-Book/Auto-Book) and `quickBookClass` (the one-click preference-based booker) both coerced slot ids to `Number(...)` for every membership/comparison check. Per AGENTS.md, normalized ids are strings, and MarianaTek spot ids are not guaranteed numeric — the mock uses ids like `mock-bag-1`. `Number('mock-bag-1')` is `NaN`, and **`Set.has(NaN)`/`Array.includes(NaN)` both match under SameValueZero**, so every non-numeric spot collapsed onto the same value: any one spot being available made `availableIds.has(NaN)` true for **all** of them.

**Fix:** every `Number(slot.id)`/`Number(s.id)` in `openBookingModal` (`client/src/ui/timetable.js` lines ~2475, 2586, 2639, 2757, 2783, 2823) and `quickBookClass` (~2284, 2298, 2304, 2317, 2345) changed to `String(...)`, with one equality check switched to the module's existing `sameId()` helper. Three occurrences inside `openDebugModal`'s dead "Slots" tab code (`availableSlots` is always `[]` there per its own comment — the `/events/{id}/slots` endpoint doesn't exist) were left as noted, out of scope.

**Test:** no new unit test added (this is DOM-rendering logic, not a pure function); covered by the browser evidence below plus the unchanged server suites (`test-adapters`, `test-no-gym-privilege` already assert string ids server-side).

**Real-browser evidence** (CDP :9222, real Chrome, `npm run dev`, `dev@psycle.com` with `jab-boxing` linked): opened the real floor-plan modal (clicked "⋯" → "Book (choose a spot)" on live JAB event 9010, a `pick-a-spot` BOXING class with mock spot ids `mock-bag-1..10`/`mock-ground-1..10`) via the actual rendered menu, not a mock.
- **Before** (fix reverted on the two lines that drive the render loop): all 20 spot bubbles rendered green/available, regardless of real per-spot occupancy.
- **After** (fix restored): only the 3 actually-available spots (`B1`, `B2`, `B3`) render green; the other 17 render as occupied — matching the live mock's per-spot availability.
- Screenshots: `c13_before.png`, `c13_after.png` in the session scratchpad.

## C1-4 — done 2026-09-26

**Root cause:** `setAuthMode('recover')` in `client/src/main.js` unconditionally set `.style.display` on `#psycle-recover-step2`, an element that no longer exists in `client/index.html` — the gym-picker step of the self-service gym-login recovery flow removed by Decision D5 (2026-08-31; a gym credential can no longer prove SA account identity). Every click on "Forgot password?" threw `TypeError: Cannot read properties of null (reading 'style')`, so the recover mode never rendered. Separately, `AUTH_MODES.recover.subtitle` still read "Confirm it's you by signing in to a gym you've linked" — describing the exact flow that was removed.

**Fix:** `client/src/main.js` — dropped the `#psycle-recover-step2` reference (only `#psycle-recover-step1` exists now); changed the subtitle to "Self-service reset isn't available yet — contact the admin." (matching the existing, already-honest copy in `client/index.html`'s `#psycle-recover-step1` panel and the admin-only reset mechanism documented in AGENTS.md).

**Test:** no new unit test (DOM-wiring fix); covered by the browser evidence below.

**Real-browser evidence** (CDP :9222, real Chrome, `npm run dev`): clicked "Forgot password?" on the real login screen.
- **Before**: `PAGEERROR: Cannot read properties of null (reading 'style')`; subtitle read the stale gym-login copy.
- **After**: no console error; subtitle reads "Self-service reset isn't available yet — contact the admin."; the form renders with its existing "Contact the admin to have your password reset" message.

## Done when

- [x] Each fix has a unit or server test where one is practical (C1-1 redaction and C1-2 401
      routing are both unit-testable). *(C1-3 and C1-4 are DOM-rendering fixes verified by
      real-browser evidence instead — see above.)*
- [x] `npm test` is green (22/22 server suites, 9/9 client test files, 76/76 client tests).
- [ ] Deployed to the dev twin. Smoke test: expire one gym's token on a two-gym account and
      confirm you stay logged in and only that gym shows "reconnect". *(Not deployed per task scope.)*
- [ ] A backup file restores on a scratch container. *(C1-5, out of scope for this pass.)*

**Detail:** [QA 2026-09-15 ISSUES](../QA/browser-runs/2026-09-15-local-mock/ISSUES.md),
[QA 2026-09-23 ISSUES](../QA/browser-runs/2026-09-23-lane-live/ISSUES.md).
