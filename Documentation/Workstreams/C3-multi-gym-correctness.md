# C3 — Multi-gym correctness

**Priority:** P1 · **Size:** ~3 days · **Depends on:** nothing (can run in parallel with C2)
**Blocks:** C4 launch

> **Verify first:** before changing anything for an item, confirm its basis in the code **and**, for anything user-visible, **in a real browser** (CDP :9222 or Claude for Chrome). For server-only items, use a failing test or a request. Record the evidence. If a browser check is needed and no browser is available, stop with `BLOCKED`. See [AGENT_PROTOCOL.md](AGENT_PROTOCOL.md).

The server-side "active gym" bug class was removed on 2026-09-16
([audit](../Archive/2026-09-26/Backlog/active-gym-audit.md)). What remains: the client's
equivalent, a few read-side leftovers, and the bugs the 2026-09-23 live run found against real
Psycle and JAB accounts.

## Live-run bugs (2026-09-23)

| # | Item | Evidence (verified 2026-09-26) | Est. |
|---|---|---|---|
| C3-1 | ✅ **Link/unlink a gym updates the app without a reload.** Settings re-renders its own cards but never refreshes the global gym context, so header badges and the timetable stay stale. [QA-09] | `client/src/ui/settings.js` link ~L1439 and unlink ~L1211, ~L1367 now call `loadGymContext`/`refreshUserData` | 2 h |
| C3-2 | ✅ **Unmetered gym (JAB) open-class button reflects membership state.** Currently it shows a credits-style state that doesn't apply. [QA-16] | `client/src/ui/timetable.js` `buildActionModel` ~L1471–1494 | 2–3 h |
| C3-3 | ✅ **The header "Member" badge checks actual membership.** It shows whenever a gym is unmetered, even when the account has no active membership. [QA-17] | `client/src/main.js` `renderGymBadge` ~L555–579 | 1 h |
| C3-4 | **Studio map editor in Settings is gym-scoped.** It falls back to an unscoped `cache.locations` when opened for a gym that isn't the context gym, so it can show another gym's rooms. [QA-18] | `client/src/ui/settings.js` ~L711–723 | 1–2 h |
| C3-5 | ✅ **Push notifications name the right gym.** Every title and body hardcodes "Psycle" ("Psycle: Spot Booked", "speak to Psycle…"). [QA-20] | `server/notifications.js` L101–144 | 1 h |

## Structural leftovers

| # | Item | Evidence | Est. |
|---|---|---|---|
| C3-6 | **Remove the client's ambient gym-context fallback.** The module-level `state` plus `setGymContext()` is the client twin of the server bug class deleted on 09-16. Anything reading it on a multi-gym account gets a guess. Make every consumer pass an explicit gym. | `client/src/gym-context.js` L27–60 | 1 day |
| C3-7 | ✅ `db.getAllUsers()` joins `user_gyms` on the literal `DEFAULT_GYM_ID`, so admin lists show Psycle data only. | `server/db.js` ~L1541–1555 | 1 h |
| C3-8 | ✅ Admin user detail: add a gym picker. `getUserDetail` resolves one ambient gym, so a JAB-only or second-gym view isn't possible. | `server/admin.js` L123; `db.js` ~L1565–1608 | 2 h |
| C3-9 | Remove the hardcoded Psycle booking-window helpers from the shared client lib (`getNextMondayNoonLondon`). Use the per-gym policy the server already exposes. | `client/src/lib.js` L188, imported by `timetable.js` | 2 h |
| C3-12 | ✅ **Background auto-book uses the ACTIVE gym's session, not the row's gym.** `scheduler.js bookSlotWithRelogin(userId, gymId, …)` reads `db.getUserById(userId).jwt`, which resolves the user's *active* gym; neither `scheduler.js` nor `poller.js` wraps per-row work in `db.runWithGymContext`. So a JAB queue entry for a user whose active gym is Psycle is sent with Psycle's token and is expected to 401, then relogin for JAB. Check `poller.js` for the same pattern. Found 2026-09-26 during C2-3, code-confirmed and not yet reproduced. **Blocks C4 JAB launch.** | `server/scheduler.js` L361–374 | 1–2 h |

## Error handling / copy

| # | Item | Evidence | Est. |
|---|---|---|---|
| C3-10 | ✅ An account with no linked gym (409 `NO_GYM_LINKED`) shows a "Failed to load filters metadata" error toast. Treat it as the normal empty state. [QA-01] | `client/src/api.js` `getMetadata()` ~L384 | 30 min |
| C3-11 | ✅ The invalid-credentials error should name the gym that failed ("JAB rejected your password"). [QA-04] | `server/providers/codexfit.js` ~L157; `routes-normalized.js` ~L171 | 30 min |

## Done when

- [ ] Each fix has a test where practical. C3-6 should add a guard test, as
      `test-no-active-gym.js` does for the server.
- [ ] Re-run the affected rows of the 09-23 live matrix on the dev twin with the two-gym test
      account.

---

## Client-side items completed 2026-09-27

### C3-10 — gym-less account shows a "Failed to load filters metadata" toast on reload

**Verified before (real browser, CDP :9222, local dev server, Node 20):** created a fresh SA
account with no gym via signup (`c3-10-<ts>@test.local` / `testpass123`); confirmed
`onLoginSuccess()` correctly routes straight to the "Connect a gym" screen right after signup
(no bug there). The bug is on **reload while already logged in with no gym linked**:
`checkAuth()` (`client/src/main.js` ~L1059) calls `initApp()` directly with no equivalent
no-gym check, so `initTimetable()` → `prefetchTimetableData()` → `loadMetadata()` calls
`api.getMetadata()`, which always hit `/api/metadata` regardless of linked-gym count. The
server answered `409 NO_GYM_LINKED` (confirmed via console network log), and `loadMetadata()`'s
catch (`client/src/ui/timetable.js` ~L298-301) has no code check, so it always renders
`showToast('Failed to load filters metadata.', 'error')`. Reproduced twice per reload (once
from `initTimetable`, once from the My Bookings tab's own `loadMetadata()` call) — captured
console: `TOAST CONTENT: "❌Failed to load filters metadata.\n❌Failed to load filters metadata."`

**Root cause:** `client/src/api.js` `getMetadata()` (previously ~L384-388) unconditionally
called `apiFetch('/api/metadata')` even when `linked.length === 0` — there was no short-circuit
for the legitimate zero-gym state, unlike other flows that route through `NO_GYM_LINKED`
correctly (`onLoginSuccess`'s explicit `getMyGyms().gyms.length === 0` check).

**Fix:** `client/src/api.js` `getMetadata()` ~L384-392 — when `getMyGyms()` returns zero linked
gyms, resolve immediately to `{ locations: [], studios: [], instructors: [], eventTypes: [] }`
without ever calling `/api/metadata`. This is the true root cause fix (avoids the 409 entirely
rather than papering over the toast), and it composes with the existing "not loaded is not
zero" rule — this *is* zero, correctly, for an account that has no gym to have any metadata for.

**Test:** `client/src/api-no-gym.test.js` (2/2 passing) — asserts `getMetadata()` resolves to the
empty shape and never calls `fetch` when `getMyGyms()` returns `{ gyms: [] }`, and that a normal
single-gym account is unaffected.

**Verified after (same browser, same account, real reload — cleared SW/CacheStorage/IndexedDB
first):** reloaded with the same gym-less account's token still in `localStorage`. Console now
shows the metadata/bookings/profile 409s still logged (out of scope — no toast is wired to
those) but **no "Failed to load filters metadata" toast**; `#psycle-toast-container` innerText
is empty. Screenshot evidence: `c3_10_after_fix.png` (scratchpad, not committed).

**Note (not fixed, logged for later):** `checkAuth()`'s reload path still boots the full app
(and its 409-generating requests for bookings/profile) for a gym-less account instead of
routing to the "Connect a gym" screen the way `onLoginSuccess()` does on first login. No visible
toast results from this today, but a proper fix would teach `checkAuth()` the same no-gym check
`onLoginSuccess()` has (`client/src/main.js` ~L1059 vs ~L1116-1122) rather than relying on every
individual API method silently no-op'ing. Left out of this item's scope (C3-10 is about the
toast, and the toast is gone); flagging in case a future pass wants the redirect too.

### C3-1 — link/unlink a gym in Settings left header badges stale until reload

**Verified before (real browser, CDP :9222, dev@psycle.com, both gyms linked):** confirmed
`#psycle-header-credits` showed `JAB | Member | PSYCLE | 18 cr`. Opened Settings → Your Gyms,
unlinked JAB (double-click confirm) — server-side unlink succeeded (`GET /api/my-gyms`
afterwards, via direct fetch in the page, no longer listed `jab-boxing`) but
`#psycle-header-credits` still read `JAB | Member | PSYCLE | 18 cr` with **no reload**.

**Root cause:** `client/src/ui/settings.js`'s unlink handlers (~L1211, ~L1367) and link handler
(~L1439) call `api.unlinkGym`/`api.linkGym` and re-render only Settings' own gym card
(`renderGymsCard`/`renderGymSettingsSection`). None of them called `loadGymContext()`
(`client/src/main.js`), which is the only thing that calls `setLinkedGyms()` — the header credit
badges (`updateCreditBadge()`, driven by `getLinkedGyms()`) and capability gates
(`applyCapabilityGates()`) both read state that only that function refreshes.

**Fix:** all three call sites in `client/src/ui/settings.js` now `await loadGymContext()`
followed by `await refreshUserData(true)` after a successful link/unlink, before/alongside their
existing Settings-panel re-render:
- unlink (double-click, gyms list) ~L1211-1217
- unlink (per-gym settings pane) ~L1367-1373
- link/re-auth (modal submit) ~L1439-1448 (sequenced, not `Promise.all`, since
  `refreshUserData` reads the linked-gym list `loadGymContext` just set)

`loadGymContext()` alone updates the list capability gates read but does **not** re-render the
header — that render happens inside `refreshUserData()`'s `updateCreditBadge(availableCredits)`
call, discovered when the first pass (`loadGymContext()` only) left the badges still stale in
the same browser check; `refreshUserData` was added once that was reproduced.

**Test:** not added as a vitest unit — `settings.js`'s link/unlink handlers are DOM-event-bound
closures over module-level state (`renderGymsCard`, `gymModal`) with a heavy `main.js` import
chain (same jsdom friction hit in C3-10: `window.matchMedia`/`localStorage` polyfills needed just
to import the module), so a meaningful unit test would mostly be re-testing jsdom plumbing
rather than the wiring bug itself. Verified end-to-end in the real browser instead (below), which
is the check that actually exercises the DOM handlers, the API calls, and the header re-render
together.

**Verified after (same browser, same account, cleared SW/CacheStorage/IndexedDB, real reload
first to load the new bundle):** reloaded → badges `JAB | Member | PSYCLE | 18 cr`. Unlinked JAB
→ badges immediately became `PSYCLE | 18 cr`, **no reload**. Re-linked JAB
(`dev@jabboxing.mock`) → badges immediately became `JAB | Member | PSYCLE | 18 cr` again, **no
reload**. Screenshot evidence: `c3_1_final.png` (scratchpad, not committed).

### C3-3 — header "Member" badge ignored actual eligibility for an unmetered gym

**Verified before (real browser, CDP :9222, dev@psycle.com, both gyms linked):** the dev
MarianaTek mock always answers `GET /api/eligibility` with `{ canBook: true }` (comment in
`server/mock-marianatek.js` L9: modeled with an always-active membership since the real JAB
test account has no credits to exercise write paths with), so the bug can't be reproduced against
the mock's default response. Used Playwright's `page.route()` to intercept
`GET /api/eligibility` for `x-gym-id: jab-boxing` and answer
`{ canBook: false, reason: 'No active membership or credits' }` — a real response substituted at
the network layer, then let the actual running app code (real `refreshUserData`/
`updateCreditBadge`/`renderGymBadge`) consume it, which is the same technique
`server/test-invalid-credentials-naming.js` uses server-side to force a rejection shape. On the
pre-fix code the header still read `JAB | Member | PSYCLE | 18 cr` — the "Member" pill rendered
regardless of the forced-ineligible response.

**Root cause:** `client/src/main.js` `renderGymBadge()` (~L555-573) took only an `isMetered`
flag; the `else` branch rendered "Member" unconditionally for any unmetered gym, never
consulting `cache.eligibility`/`cache.eligibilityByGym` (already computed correctly elsewhere —
`client/src/ui/credit-allowance.js`'s `canBookAtAll(gymId)`/`getIneligibleReason(gymId)`, used by
the timetable's own booking-eligibility gate — but never wired into the header badge).

**Fix:** `client/src/main.js` ~L555-582 — `renderGymBadge()` now checks `canBookAtAll(gymId)`
before rendering "Member": renders the existing green "Member" pill when eligible or unknown
(same "unknown defaults ON" permissive rule as capability flags — an unset/loading eligibility
answer must not itself hide the badge), and a new amber "No membership" pill
(`.psycle-hgb-pill.inactive`, `client/src/styles.css` ~L6634) with `getIneligibleReason(gymId)`
in the title only once the server has confirmed no active membership. Also wired
`updateCreditBadge()` to re-run when the fire-and-forget per-gym eligibility fetch resolves
(`main.js` ~L919, alongside the existing `repaintTimetableIfVisible()` call) — without this the
badge would keep its permissive first-paint state even after the real per-gym answer landed,
same bug class as the timetable repaint this pattern already existed for.

**Test:** relies on the existing `client/src/ui/credit-allowance.test.js` coverage for
`canBookAtAll`/`getIneligibleReason` (already 100% passing, unchanged); no new unit test added
for `renderGymBadge` itself — it is a DOM-building closure in `main.js`'s heavy import chain (same
jsdom friction as C3-1), so real-browser verification with a forced network response was the
practical + honest check for the actual wiring bug (the underlying eligibility logic was already
correct and already tested).

**Verified after (same browser, same route interception, cleared SW/CacheStorage/IndexedDB,
real reload):** with the forced `canBook: false` response, header now reads
`JAB | No membership | PSYCLE | 18 cr`. Re-ran the same interception against the pre-fix code
(`git stash` the fix, same check, `git stash pop` to restore) and confirmed it reproduces the
stale "Member" pill, then re-confirmed the fix again after restoring. Normal (non-intercepted,
real dev-mock) reload still shows `JAB | Member | PSYCLE | 18 cr` — the working case is
unaffected. Screenshot evidence: `c3_3_after_fix_real.png` (scratchpad, not committed).

### C3-2 — JAB (unmetered) open-class button showed "Buy Credits" for an ineligible account

**Verified before (real browser, CDP :9222, dev@psycle.com with JAB linked):** same
route-interception technique as C3-3 (dev mock always answers JAB eligibility as active, per
`server/mock-marianatek.js` L9) — forced `GET /api/eligibility` for `x-gym-id: jab-boxing` to
`{ canBook: false }`, reloaded, opened the Timetable tab. Every open JAB row's primary button
read **"Buy Credits"** and, on click, routed to `window.switchTab('buy-credits')` — a tab whose
purchase flow JAB doesn't have (`gyms.config.js` `jab-boxing.capabilities.creditPurchase: false`,
`metered: false`). Captured via `page.$$eval` on JAB rows before the fix: all "not bookable"
rows showed `{"text":"Buy Credits","title":"","disabled":false}`.

**Root cause:** `client/src/ui/timetable.js` `buildActionModel()`'s `if (!hasCredit)` branch
(~L1471, before the fix) always rendered "Buy Credits" regardless of *why* `hasUsableCredit()`
was false. That function is false for two structurally different reasons
(`client/src/ui/credit-allowance.js`): a metered gym's balance can't afford the class, or an
unmetered gym's `canBookAtAll()` has confirmed no active membership/credits at all. Only the
first reason has an in-app fix ("buy more credits"); showing it for the second pointed at a
purchase flow that gym doesn't have — the same class of bug as C3-3's badge, one level down in
the same file.

**Fix:** `client/src/ui/timetable.js` ~L1471-1494 — `buildActionModel()` now branches on
`isMetered(event.gymId)` (imported from `credit-allowance.js`) before choosing the label:
metered keeps "Buy Credits" exactly as before; unmetered renders a disabled "No Membership"
primary button with `getIneligibleReason(event.gymId)` in the tooltip (same reason string the
status pill beside it already surfaces). Added `title` wiring for `model.primary.title` to both
`buildDesktopActions()` (~L1830) and `buildMobileClassRow()`'s primary button (~L2069), since
neither previously read a `title` off the action model at all.

**Test:** no new unit test — `buildActionModel` is a private (non-exported) function in
`timetable.js`'s heavy import chain (same jsdom friction noted in C3-1/C3-3), and the underlying
`isMetered`/`getIneligibleReason` logic it calls is already covered by
`client/src/ui/credit-allowance.test.js` (unchanged, still 100% passing). Verified end-to-end in
the real browser instead, which is what actually exercises the label decision.

**Verified after (same browser, same route interception, cleared SW/CacheStorage/IndexedDB,
real reload):** every open JAB row now reads `{"text":"No Membership","title":"No active
membership or credits","disabled":true}`; Psycle rows and JAB's not-yet-live rows ("Auto-Book")
are unaffected. Re-ran the same check against the pre-fix code (`git stash`/`git stash pop`) and
confirmed it reproduces "Buy Credits", then re-confirmed the fix again after restoring.
Screenshot evidence: `c3_2_state.png` (scratchpad, not committed).

## Server-side items completed 2026-09-26 (C3-12, C3-5, C3-7, C3-8, C3-11)

Client items C3-1/2/3/4/6/9/10 are untouched — out of scope for this pass (a later agent owns
them). `npm test`: **31/31 server suites, 76/76 client tests** (client suite unaffected by these
changes; run to confirm nothing broke).

### C3-12 — background auto-book/auto-upgrade used the ACTIVE gym's session, not the row's

**Root cause (confirmed by a failing test first, `server/test-background-gym-session.js`):**
`scheduler.js`'s `bookSlotWithRelogin`/`fetchFromGym` and `poller.js`'s
`bookSlotWithRelogin`/`swapSpotsWithRelogin`/`fetchFromGym` all read the session via
`db.getUserById(userId).jwt`, which resolves through `mergeUserWithGym(user,
resolveActiveGymId(userId))` — the user's default/active gym. Background work has no per-request
`gymContext` (confirmed via `db.js`'s own comment on `AsyncLocalStorage` and
`test-active-gym.js`'s "background work (no context, several links) resolves deterministically"
case), so this always resolved to `DEFAULT_GYM_ID` (psycle-london) regardless of which gym the
queue row actually belonged to. A JAB row for a user whose default is Psycle was sent with
Psycle's token.

**Fix:** every one of those call sites now reads `db.getUserSession(userId, gymId)` — the
existing per-gym-explicit accessor already used correctly elsewhere in the same files
(`attemptUpgradeSlot`'s event-details fetch, `listBookingsWithRelogin`, `bookingCacheRowsFor`,
`sendBookingWindowTip`). `calendar.js` was audited and confirmed already correct (it wraps
`db.getUserById` in `db.runWithGymContext`).

- `server/scheduler.js` `fetchFromGym` (~L259–276), `bookSlotWithRelogin` (~L361–366)
- `server/poller.js` `fetchFromGym` (~L40–58), `swapSpotsWithRelogin` (~L91–95),
  `bookSlotWithRelogin` (~L104–107)

**Extra bug found during the audit (same file, same root class):** `poller.js`'s cancel-then-
rebook cleanup called `apiCancelBooking(userId, upgrade.booking_id)` — **missing the `gymId`
argument entirely** (signature is `apiCancelBooking(userId, gymId, bookingId)`), so `gymId`
silently received `upgrade.booking_id` (a number) and `bookingId` was `undefined`, producing a
`DELETE /bookings/undefined` against whatever gym that number happened to resolve to. Fixed at
the call site (~L293-299) to pass `gymId` explicitly.

**Test:** `server/test-background-gym-session.js` — 3/3 passing. Seeds a two-gym user (session
tokens distinct per gym, no `runWithGymContext` anywhere — exactly what the cron sees), stubs
`MarianaTekProvider.prototype.bookSlot`/`swapSpots`/`request` to capture the session used, and
proves a JAB-boxing auto-book row and an atomic-swap auto-upgrade monitor now use JAB's own
token, not Psycle's. Failed before the fix (captured `PSYCLE-TOKEN-*` for all three); passes
after.

### C3-5 — push notifications hardcoded "Psycle"

**Root cause:** every builder in `notifications.js` (`buildBooking`, `buildUpgrade`,
`buildCreditWarning`, `buildCancellationReminder`, `buildBookingWindow`) hardcoded the literal
"Psycle" in the title/body. `buildProviderThrottled` was already gym-aware (reads
`ctx.gymId` → `gyms.config.js`), showing the pattern to follow.

**Fix:** added `gymShortName(gymId)` (falls back to the registry default rather than throwing if
a caller omits it) and threaded `ctx.gymId` through every builder. Every `notify()` call site was
updated to pass its own `gymId`:
- `server/scheduler.js` L584 (`booking`, from the row's `gym_id`)
- `server/poller.js` L325/L341 (`upgrade`, from `attemptUpgradeSlot`'s own `gymId`), L553
  (`cancellationReminder`, from `bk.gym_id`)
- `server/server.js` L337 (`booking`, `db.resolveActiveGymId(req.userId)`), L405 and L534
  (`creditWarning`, the route's own `gymId`)
- `providerThrottled` (`scheduler.js` L80) and `bookingWindow` (`poller.js` L639) already passed
  `gymId` — `buildBookingWindow` just wasn't reading it; fixed.

**Fix location:** `server/notifications.js` L101–170 (builders + `gymShortName`).

**Test:** `server/test-notification-gym-naming.js` — 10/10 passing. Calls `notify()` for every
type with `gymId: 'psycle-london'` and `gymId: 'jab-boxing'`, asserting the rendered title+body
contains the right short name and never the other gym's name.

### C3-7 — `db.getAllUsers()` joined on the literal `DEFAULT_GYM_ID`

**Root cause:** the query `LEFT JOIN user_gyms ug ON ug.gym_id = ?` was called with
`DEFAULT_GYM_ID` for every row, so a JAB-only account (no `psycle-london` link at all) never
matched the join: `display_name` came back `NULL`, `priority` fell through to the legacy 100
default, and there was no session — i.e. exactly "admin lists show Psycle data only".

**Fix:** `server/db.js` `getAllUsers()` (~L1541–1583) now resolves each user's own gym via
`resolveActiveGymId(r.id)` (same fallback chain as everywhere else with no request context: sole
link → default gym → first link) and reads that link's own `display_name`/`priority`/
`profile_synced_at`/session. Added `active_gym_id` to the response so the admin UI can label
which gym a row's summary belongs to.

**Test:** `server/test-admin-gym-aware.js` — 3/3 passing. A JAB-only account now shows its own
display name/priority/session; a Psycle-only account is unaffected (behaviour preservation); a
two-gym account resolves to the default gym, matching `resolveActiveGymId` exactly.

**Real-browser evidence (2026-09-26, local dev server + CDP :9222):** created a two-gym test
account (`c3agent2@test.local`, linked to both `psycle-london` and `jab-boxing`, distinct
`display_name`/`priority` per link). The admin user list correctly showed "Psycle View Pete"
(priority 5) — the JAB-only account (no display name set) showed as "—" with priority 200,
proving neither account defaulted to blank/Psycle-only data incorrectly.

### C3-8 — admin user detail had no gym picker

**Root cause:** `GET /api/admin/users/:id` always called `db.getUserDetail(userId)` with no gym,
which resolves through `db.resolveActiveGymId(userId)` — one ambient gym, so a JAB-only or
second-gym view of a multi-gym account was never reachable from the admin panel.

**Fix:**
- `server/admin.js` (~L117–145, ~L256–264): accepts `?gymId=`, validates it via
  `db.isGymLinked(userId, gymId)` (403 if not linked — same rule `auth.js`'s `withGymContext`
  applies to the `x-gym-id` header), and runs the whole handler through
  `db.runWithGymContext(userId, gymId, handle)` when present — the same mechanism
  `calendar.js` already uses for per-gym background work. Response now includes `viewedGymId`.
  With no `?gymId=`, behaviour is unchanged.
- `server/admin.html`: added a `<select id="drawer-gym-picker">` next to the drawer header,
  populated from `d.gyms`, hidden for a single-gym account, `onchange` re-fetches
  `openDetail(userId, picker.value)`.

**Test:** `server/test-admin-gym-picker.js` — 4/4 passing (DB-level: proves
`runWithGymContext(uid, 'jab-boxing')` makes `getUserDetail` resolve the JAB link instead of the
default, that `isGymLinked` is the gate the route uses, and that context never leaks across
users in the same request — the admin-reads-another-account case).

**Real-browser evidence (2026-09-26, local dev server + CDP :9222):** opened the admin panel,
opened the two-gym test account's detail drawer (defaulted to "Psycle London (viewing)",
Priority 5, CodexFit ID 99999, Ride-studio stats). Switched the picker to "JAB Boxing Club" and
the drawer re-fetched and re-rendered: Priority changed to 7 · VIP, CodexFit ID changed to
`mock-user`, Stats changed to "No stats in cached profile", Credits changed to 0 — all matching
JAB's own linked data, proving the gym switch actually re-resolves session/profile/priority
rather than always showing the default gym.

### C3-11 — invalid-credentials error didn't name the gym

**Root cause:** `providers/codexfit.js login()` threw a gym-less `errorData.message` (or a bare
"Login failed with status …"); `providers/marianatek.js login()` threw `"MarianaTek login
failed: …"` — the **platform** name, not the gym's (a WP-D7 violation on its own). Both classes
already carry `this.gym` (set in `base.js`'s constructor) but neither error path referenced it.
`routes-normalized.js`'s `POST /api/my-gyms/link` (~L171–177) passes `err.message` straight
through to the client, so the fix at the provider layer is sufficient — no route change needed.

**Fix:** `server/providers/codexfit.js` (~L183–190) and `server/providers/marianatek.js`
(~L200–208) now prefix/name the error with `this.gym.shortName` (falls back to "The gym" if
absent), e.g. `"JAB rejected your login: incorrect email/password"`.

**Test:** `server/test-invalid-credentials-naming.js` — 2/2 passing. Stubs `fetch` to return the
documented rejection shapes for each platform (CodexFit 401 JSON error; MarianaTek's "login page
re-rendered instead of redirecting" signal) and asserts the resulting error names the correct
gym and never the other gym/platform.

**Note on browser verification:** the mandated check ("link-gym flow with a wrong password
against the mock") is **not reproducible as specified** — both dev mock accounts
(`dev@psycle.com`, `dev@jabboxing.mock`) bypass password validation entirely by design (`email
=== DEV_EMAIL` short-circuits before any credential check in both `login()` methods), and any
other email routes to the real gym over the network, which this pass must not do
(no-live-traffic rule). Verified at the adapter level instead (test above) as the strongest
evidence available without violating that rule; logged here rather than silently skipped.
