# C3 — Multi-gym correctness

> **ARCHIVED 2026-10-06 — FINISHED.** Moved from `Workstreams/`. All C3 items and the verified hunt are closed.

> **STATUS 2026-10-06: FULLY DONE.** C3-1..C3-29 are all fixed and verified (fix log and evidence below). The U1-20-class hunt was verified on 2026-10-06: 15 of 16 candidates were invalid; **1 valid (M)** was a failed per-gym bookings/waitlists fetch wiping that gym's reminder cache—**fixed 2026-10-06 with test `test-booking-sync-scope.js`** (client tracks loaded gyms, server filters cache scope). C3 can be archived. C4 no longer waits on C3 rows.

**Priority:** P1 · **Size:** ~3 days · **Depends on:** nothing (can run in parallel with C2)
**Blocks:** C4 launch

> **Verify first:** before changing anything for an item, confirm its basis in the code **and**, for anything user-visible, **in a real browser** (CDP :9222 or Claude for Chrome). For server-only items, use a failing test or a request. Record the evidence. If a browser check is needed and no browser is available, stop with `BLOCKED`. See [AGENT_PROTOCOL.md](../Workstreams/AGENT_PROTOCOL.md).

The server-side "active gym" bug class was removed on 2026-09-16
([audit](../../Archive/2026-09-26/Backlog/active-gym-audit.md)). What remains: the client's
equivalent, a few read-side leftovers, and the bugs the 2026-09-23 live run found against real
Psycle and JAB accounts.

## Live-run bugs (2026-09-23)

| # | Item | Evidence (verified 2026-09-26) | Est. |
|---|---|---|---|
| C3-1 | ✅ **Link/unlink a gym updates the app without a reload.** Settings re-renders its own cards but never refreshes the global gym context, so header badges and the timetable stay stale. [QA-09] | `client/src/ui/settings.js` link ~L1439 and unlink ~L1211, ~L1367 now call `loadGymContext`/`refreshUserData` | 2 h |
| C3-2 | ✅ **Unmetered gym (JAB) open-class button reflects membership state.** Currently it shows a credits-style state that doesn't apply. [QA-16] | `client/src/ui/timetable.js` `buildActionModel` ~L1471–1494 | 2–3 h |
| C3-3 | ✅ **The header "Member" badge checks actual membership.** It shows whenever a gym is unmetered, even when the account has no active membership. [QA-17] | `client/src/main.js` `renderGymBadge` ~L555–579 | 1 h |
| C3-4 | ✅ **Studio map editor in Settings is gym-scoped.** It falls back to an unscoped `cache.locations` when opened for a gym that isn't the context gym, so it can show another gym's rooms. [QA-18] | `client/src/ui/settings.js` `openManageSpotMapsModal` ~L711–759 | 1–2 h |
| C3-5 | ✅ **Push notifications name the right gym.** Every title and body hardcodes "Psycle" ("Psycle: Spot Booked", "speak to Psycle…"). [QA-20] | `server/notifications.js` L101–144 | 1 h |

## Structural leftovers

| # | Item | Evidence | Est. |
|---|---|---|---|
| C3-6 | ✅ **Remove the client's ambient gym-context fallback.** The module-level `state` plus `setGymContext()` is the client twin of the server bug class deleted on 09-16. Anything reading it on a multi-gym account gets a guess. Make every consumer pass an explicit gym. | `client/src/gym-context.js` (was L27–60) | 1 day |
| C3-7 | ✅ `db.getAllUsers()` joins `user_gyms` on the literal `DEFAULT_GYM_ID`, so admin lists show Psycle data only. | `server/db.js` ~L1541–1555 | 1 h |
| C3-8 | ✅ Admin user detail: add a gym picker. `getUserDetail` resolves one ambient gym, so a JAB-only or second-gym view isn't possible. | `server/admin.js` L123; `db.js` ~L1565–1608 | 2 h |
| C3-9 | ✅ Remove the hardcoded Psycle booking-window helpers from the shared client lib (`getNextMondayNoonLondon`). Use the per-gym policy the server already exposes. | `client/src/lib.js` (was L188) | 2 h |
| C3-12 | ✅ **Background auto-book uses the ACTIVE gym's session, not the row's gym.** `scheduler.js bookSlotWithRelogin(userId, gymId, …)` reads `db.getUserById(userId).jwt`, which resolves the user's *active* gym; neither `scheduler.js` nor `poller.js` wraps per-row work in `db.runWithGymContext`. So a JAB queue entry for a user whose active gym is Psycle is sent with Psycle's token and is expected to 401, then relogin for JAB. Check `poller.js` for the same pattern. Found 2026-09-26 during C2-3, code-confirmed and not yet reproduced. **Blocks C4 JAB launch.** | `server/scheduler.js` L361–374 | 1–2 h |

## Error handling / copy

| # | Item | Evidence | Est. |
|---|---|---|---|
| C3-10 | ✅ An account with no linked gym (409 `NO_GYM_LINKED`) shows a "Failed to load filters metadata" error toast. Treat it as the normal empty state. [QA-01] | `client/src/api.js` `getMetadata()` ~L384 | 30 min |
| C3-11 | ✅ The invalid-credentials error should name the gym that failed ("JAB rejected your password"). [QA-04] | `server/providers/codexfit.js` ~L157; `routes-normalized.js` ~L171 | 30 min |

## Done when

- [x] Each fix has a test where practical (2026-09-27). C3-6 added a guard test,
      `client/src/gym-context-no-ambient.test.js`, alongside the existing server-side
      `test-no-active-gym.js` source scan.
- [x] **Re-ran the affected rows of the 09-23 live matrix on the dev twin 2026-09-27** (HEAD
      `2952eec`, deployed same day), real two-gym account (`test@piersj.com`, Psycle + JAB),
      CDP :9222 real Chrome, one dedicated tab, all three client caches cleared before
      checking:
      - **C3-3 (header badge):** header read `JAB | No membership | PSYCLE | 0 cr` on the
        real account (which genuinely has no active JAB membership) — no forced route
        interception needed this time, the live data reproduces the fixed state directly.
      - **C3-2 (JAB button):** every open JAB row's primary button read "No Membership"
        (confirmed via DOM query across 8+ sampled rows), never "Buy Credits".
      - **C3-4 (studio map editor):** JAB's "Manage maps" modal grouped studios under "SW1"
        with BOXING/TRAIN listed; Psycle's modal (opened in the same session immediately
        after) showed its own BANK/LONDON BRIDGE/NOTTING HILL/OXFORD CIRCUS/SHOREDITCH/
        VICTORIA locations — no cross-gym leakage, no "Unknown Location".
      - **C3-1 (link/unlink refresh):** **not exercised live** — this is a real gym account
        and unlinking would require the user's actual gym password to re-link, which this
        pass doesn't have. Skipped per the task's own instruction to only do link/unlink
        "if it's safe to re-link without the user's password". Client-side fix already
        covered by the 2026-09-26 local-mock evidence above.
      - **C7-1 (no 429s):** swept all 5 tabs twice (Timetable → My Bookings → Auto-Book →
        Credits → Settings → Timetable): 62 sequential `/api/*` calls, all HTTP 200, zero
        429s.
      - Notification/admin gym-naming (C3-5/C3-7/C3-8/C3-11) were not separately re-checked
        live in this pass (no new push notification or admin-panel action was triggered);
        already covered by their 2026-09-26 server-test + local-browser evidence above.

---

## C3-13 — JAB header badge said "No membership" while the account has an active membership (investigated 2026-09-27, NOT REPRODUCED — no code change)

**Basis for the item:** the 2026-09-27 dev-twin C4 Stage A re-test reported the header badge as
`JAB | No membership`, matching the actual live eligibility answer at that moment (`test@piersj.com`
had `GET /api/eligibility` → `canBook:false`). A later pass **in the same day** saw live
`GET /api/membership` show an **active** JAB membership (`isActive:true`, 2/2 guest passes) on the
same account, and flagged the two as possibly contradictory — hence this item.

**Investigation (code):** the header badge (`client/src/main.js renderGymBadge`, gated on
`canBookAtAll(gymId)` from `client/src/ui/credit-allowance.js`) and the Credits & Membership tab
(`client/src/ui/credits.js`, via `api.getMembership(gymId)` → `GET /api/membership`) read two
different routes, but both routes are backed by the **same underlying computation** on the server:
`providers/marianatek.js getEligibility()` (~L386) calls `this.getMembership(session)` internally
and returns `canBook: true` whenever `membership.isActive` is true — there is no separate,
divergent membership-active check for the badge to disagree with. `getMembership()`'s client route
(`client/src/api.js` ~L647) is the only one of the two that's cached (`getCachedSWR`, 10-min TTL);
`getEligibility()` (~L621) is a plain uncached `apiFetch`. A 10-min-stale membership cache could in
principle show an OLD "active" answer next to a freshly-negative eligibility badge, but never the
reverse (a stale-negative membership cache next to a correctly-positive eligibility badge, which is
the direction this item describes) — so the one caching asymmetry that does exist cannot produce
the reported symptom either.

**Investigation (live, read-only, 2026-09-27, dev twin, CDP `127.0.0.1:9222`, one dedicated tab,
`test@piersj.com`, closed afterward):**

| Call | Result |
|---|---|
| `GET /api/eligibility` (`x-gym-id: jab-boxing`) | `{"canBook":true,"expiresAt":null}` |
| `GET /api/membership?gymId=jab-boxing` | `{"membership":{"id":"2552","name":"SW1 Rolling Membership","status":"Active","isActive":true,"guestPassesRemaining":2,"guestPassesTotal":2,"bookingWindowLabel":"Reserve 14 days in advance",...}}` |
| Rendered header badge (real reload, fresh page load) | `JAB Member` / title `"JAB: Membership active"` — matches both calls above exactly |

All three signals agree, right now, in this session: eligibility, membership, and the rendered
badge all say "active member." (Psycle's own badge in the same capture read "0 cr" — the C2-7 bug,
not yet redeployed to this dev twin at the time of this check; unrelated to C3-13.)

**Verdict: NOT REPRODUCED — no code bug found, no change made.** The badge and the membership tab
share one code path (`getEligibility()` calls `getMembership()` directly), so they cannot
structurally disagree at the same instant, and this session's live read shows them agreeing. The
most consistent explanation, matching C4-9's own contemporaneous note ("this is a live-state change
from the prior session's finding... recorded, not acted on"), is that the JAB test account's real
membership state on the provider's own system changed between the two 2026-09-27 sessions — e.g. a
lapsed/reactivated membership or a payment retry — and the badge was correctly reporting whatever
the server answered at each point in time. Logged here as investigated-and-waived rather than
silently dropped, per AGENT_PROTOCOL.md's "can't reproduce? don't change code, add a dated note."

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

### C3-4 — Settings studio-map editor leaked another gym's rooms (or emptied)

**Verified before (real browser, CDP :9222, dev@psycle.com, both gyms linked):** opened
Settings → Psycle London → Manage maps (`openManageSpotMapsModal({ gymId: 'psycle-london' })`) —
correctly showed `CLAPHAM / MORTIMER STREET / SHOREDITCH`. Closed it, opened Settings → JAB
Boxing Club → Manage maps (`{ gymId: 'jab-boxing' }`) in the **same page session** (no reload) —
the modal read `No Studios With Seat Maps`, even though `GET /api/metadata` with
`x-gym-id: jab-boxing` confirms JAB has 2 studios with seat layouts (`mock-room-BOXING`,
`mock-room-TRAIN`). Captured via direct DOM read of the overlay: `"Preferred Spot Maps\n×\n🗺️\n\nNo
Studios With Seat Maps..."`.

**Root cause:** `client/src/ui/settings.js` `openManageSpotMapsModal()` ~L711 (before fix):
`let locations = cachedMeta?.locations || cache.locations || [];` — `cache.locations` is an
unscoped module-level variable with no gym tag, last written by whichever gym's modal opened
most recently. Opening Psycle's modal first set it to Psycle's 4 locations; opening JAB's modal
next read that stale value as non-empty, which skipped the fresh-fetch block for JAB
altogether. The later per-gym narrowing filter (~L752,
`locations.filter(item => !item.gymId || item.gymId === options.gymId)`) then correctly rejected
every Psycle-tagged location as not matching `jab-boxing`, leaving `locations = []` — so instead
of leaking Psycle's rooms under JAB's label, the symptom was every studio grouping under no
location at all and getting excluded, rendering the empty state.

**Fix:** `client/src/ui/settings.js` ~L711-736 — the unscoped `cache.locations` fallback is now
read (and written) only in the ambient case (`!options.gymId`), matching the rule already applied
two lines above for `cachedMeta`/`cachedEvents`: an explicit `gymId` is by definition asking for
a gym that fallback may not hold, so it must not be trusted, and a gym-scoped fetch must not
pollute it for the next ambient caller either.

**Second bug found while verifying the fix (same function, same call path):** with `locations`
now correctly empty for JAB, the fresh-fetch path ran, but the modal *still* showed "No Studios"
— `events.map(ne => ({ studio_id: Number(ne.studioId), ... }))` (~L753) cast every event's studio
id through `Number()`. Psycle's studio ids happen to be numeric-looking strings ("138"), so this
was silently a no-op there; MarianaTek's are not ("mock-room-BOXING"), so `Number(...)` was `NaN`
for every JAB event, `activeStudioIds` ended up `{NaN}`, and the "exclude defunct studios" filter
(which compares via `String(studio.id)`, never expecting a numeric compare in the first place)
excluded every real studio. This is the same "normalized ids are strings" class of bug AGENTS.md
already flags twice elsewhere (WP-D9). Fixed by dropping the `Number()` cast — the id is kept as
whatever string the provider gave it, matching how the exclusion check already compares.

**Test:** no new unit test — same jsdom/module-coupling friction as C3-1/C3-2/C3-3 for a
DOM-building function in `settings.js`'s heavy import chain. Verified end-to-end in the real
browser (below), including the exact repro sequence (open gym A's modal, then gym B's, in one
session) that a unit test would have to fake the DOM/cache module state to reproduce anyway.

**Verified after (same browser, same account, cleared SW/CacheStorage/IndexedDB, real reload,
same open-A-then-B sequence):** Psycle's modal: `CLAPHAM / MORTIMER STREET / SHOREDITCH`
(unchanged). JAB's modal, opened immediately after in the same session: `SW1` (JAB's own
location), with its BOXING/TRAIN studios listed — no leakage, no false-empty state. Screenshot
evidence: `c3_4_jab_fixed.png` (scratchpad, not committed).

### C3-9 — removed the dead `getNextMondayNoonLondon()` from the client lib

**Verified before (code check):** `grep -rn getNextMondayNoonLondon client/src` showed exactly
two hits: the export in `client/src/lib.js` ~L188, and its import in
`client/src/ui/timetable.js` ~L5 — with **no call site anywhere** in either file, or anywhere
else in the client. Confirmed the item's premise directly: this was already fully dead by the
time this pass started (the server-side removal in WP-I evidently took the last real caller with
it; the client copy and its now-pointless import were never cleaned up). Every event already
carries the server-stamped `releaseAt` that `getClassReleaseTime()` (still imported and used,
`client/src/lib.js`) reads, per AGENTS.md's WP-I note.

**Fix:** deleted the `getNextMondayNoonLondon()` function from `client/src/lib.js` (was ~L186-194)
and removed the now-unused import from `client/src/ui/timetable.js` ~L5. No behaviour change —
there was no reachable code path exercising it.

**`detectBookingWindow()` (also flagged by AGENTS.md and this item's brief):** confirmed still
**live**, not dead — `client/src/main.js` ~L964 calls
`detectBookingWindow(profile, credits)` inside `refreshUserData()` to auto-detect and persist the
account's booking-window day-offset. Left in place per the item's own instruction ("only remove
if clearly dead"); AGENTS.md's existing note that it duplicates
`providers/codexfit.js resolveBookingWindow()` server-side stands as an open item, not one this
pass resolves.

**Test:** none needed — a pure dead-code deletion has nothing to assert beyond "nothing else
breaks," covered by `npm test` (client + server, both green) below.

**Verified after (real browser, CDP :9222, cleared SW/CacheStorage/IndexedDB, real reload):**
Timetable tab loads normally (66 row elements rendered), no console errors, no page errors.
`npm run build:client` also confirmed clean (see end-of-workstream verification).

### C3-6 — removed the client's ambient gym-context fallback (done in full)

**Verified before (code audit, not a browser bug — this item is structural):** an audit of every
real call site of the ambient API found it was already dead weight in the places that mattered
most, which changed the shape of the fix:
- `can(capability)` — grepped for actual invocations (not import lines) across `client/src`:
  **zero production callers.** Only used internally as a fallback inside `canForGym`/
  `capabilityForGym`/`canAny`, and directly by `gym-context.test.js`.
- `getGymContext()` — **exactly one production caller**, `client/src/ui/settings.js` ~L1365,
  comparing `gymId === getGymContext()?.gymId` ("is this the default gym") — already resolvable
  from `getLinkedGyms()[0]`, the very list `setGymContext` seeded itself from.
- `canForGym(...)`/`capabilityForGym(...)` — every real call site already passed an explicit
  `gymId` (`event.gymId`, `c.gymId`, `q.gym_id`, …); the `!gymId` ambient-fallback branch inside
  them was unreachable in practice.
- `onGymContextChange()` — **zero callers anywhere.**
- `gymLabel()`, and external callers of `applyGymTheme()`/`applyGymName()` — **zero**, only used
  internally by `setGymContext()`.
- Root `document.documentElement[data-gym]` (the CSS hook `applyGymTheme` stamped) — grepped
  `client/src/styles.css` for `:root[data-gym=` / `html[data-gym=`: **no CSS selector reads it.**
  Every `[data-gym=...]` CSS rule in the stylesheet targets a per-row element (`tr[data-gym=...]`,
  `.ab-card[data-gym=...]`), never the document root — the root stamp was dead for theming and
  only had one live side effect: loading ONE ambient gym's custom Google Font.
- `[data-gym-name]` (the About page's "your gym" copy) — the one genuinely user-visible thing
  `setGymContext` drove, via `applyGymName()`.

So the removal wasn't "delete and find replacements for everything" — most of the ambient API
had no real dependents. What needed real design was the two things that DID have a visible
effect: per-gym font loading and the About page's gym-name copy, both of which used to pick ONE
gym (`linked[0]`) to represent a possibly multi-gym account.

**Fix — `client/src/gym-context.js` fully rewritten:**
- Removed: module-level `state`, `listeners`, `onGymContextChange()`, `setGymContext()`,
  `getGymContext()`, `can()`, `gymLabel()`.
- `canForGym`/`capabilityForGym`/`canAny` now fall back straight to `DEFAULTS[capability]`
  (unchanged, still permissive-unknown-defaults-ON) instead of a guessed gym's flags when no
  `gymId` is given or the gym isn't (yet) linked.
- `applyGymTheme()`'s dead root-stamping is gone entirely (no CSS consumer, confirmed above).
- `applyGymName()` → `applyGymNames()`: fills `[data-gym-name]` from **every** linked gym, joined
  ("Psycle and JAB"), not one guessed gym. Falls back to the neutral placeholder with zero linked
  gyms, same as before.
- The font-loading half of `applyGymTheme()` → `applyGymFonts()`: loads **every** linked gym's
  custom font (keyed `gym-font-<gymId>`, idempotent per gym), not a single ambient slot that a
  two-custom-font account would have only ever gotten one of.
- Both now fire from `setLinkedGyms()` itself — the one place the full linked-gym list is already
  known — rather than needing a separate `setGymContext(oneGym)` call from outside.

**`client/src/main.js` `loadGymContext()`** (~L846-869): dropped picking `linked[0]` and calling
`setGymContext(active)` + `applyCapabilityGates()` (the latter now redundant — `setLinkedGyms()`
already calls it). Logs every linked gym's capabilities instead of just the guessed default's.

**`client/src/ui/settings.js`** ~L1359-1368: `getGymContext()?.gymId` → `getLinkedGyms()[0]?.gym_id`
(same source, no ambient module state in between).

**Dead imports removed** (found during the audit, confirming the "already dead" read): unused
`getGymContext` imports in `client/src/ui/bookings.js`, `client/src/ui/autobook.js`,
`client/src/ui/timetable.js`; unused `can` import in `client/src/ui/credit-allowance.js`.

**Tests:**
- `client/src/gym-context.test.js` — fully rewritten (19/19 passing): every capability assertion
  now names an explicit gym via `canForGym`/`capabilityForGym`/`setLinkedGyms([...])` instead of
  `setGymContext`/`can()`/`getGymContext()`; added cases for `canForGym` on an unlinked gym
  (permissive default, per-flag — `atomicSwap` defaults OFF, `bookmarks` defaults ON, matching
  each flag's own `DEFAULTS` value, not a blanket "always true"), `canAny` with zero linked gyms,
  and the new fan-out behaviour of `applyGymFonts`/`applyGymNames` (a two-gym account gets both
  fonts and a joined name).
- `client/src/ui/credit-allowance.test.js` — rewritten to pass explicit `gymId`s / event
  `gymId` fields via `setLinkedGyms([gym])` instead of `setGymContext(gym)` (18/18 passing) —
  this file's ambient-reliant calls (`isMetered()`, `getTotalCredits()` with no gymId) were
  exactly the pattern real production code never actually used, confirmed against every real
  caller of both functions.
- `client/src/gym-context-no-ambient.test.js` (new, 2/2 passing) — the vitest guard the item
  asked for: asserts `gym-context.js` no longer **exports** `setGymContext`/`getGymContext`/
  `can`/`onGymContextChange`, and still exports the explicit-gym replacements. Complements
  `server/test-no-active-gym.js`'s existing source-scan (already present, scans `client/src` for
  an ambient `can('flag')` call and already passes — its stale exclusion comment for
  `gym-context.js` was updated to reflect the removal rather than the old "defines it" reasoning).

**Verified after (real browser, CDP :9222, dev@psycle.com with both gyms linked, cleared
SW/CacheStorage/IndexedDB, real reload, full smoke across every tab):** header badges
`JAB | Member | PSYCLE | 18 cr`; Timetable, My Bookings, Auto-Book, Buy Credits, Settings all
load with **zero console/page errors**; JAB rows show `Quick Book` (correctly eligible, exercising
the per-gym capability path with no ambient fallback in the loop at all now); About page's
`[data-gym-name]` now reads **"JAB and Psycle"** (previously would have silently picked one).
Re-ran the C3-1 (link/unlink), C3-2/C3-3 (forced-ineligible via `page.route()`), and C3-4
(cross-gym spot-map) browser checks from earlier in this pass against the post-refactor code —
all still pass identically, confirming the refactor didn't regress any of the day's other fixes.

**`npm test` after this item: 31/31 server suites, 86/86 client tests** (up from 78 — 8 new
tests: 2 in `credit-allowance.test.js`'s rewrite net, several new cases in
`gym-context.test.js`'s rewrite, 2 in the new guard file). `npm run build:client` clean.

**Scope note:** this item is DONE IN FULL, not partially — it came in well under the ~1 day
estimate once the audit showed most of the ambient surface had no real dependents left to
migrate. No remainder to report.

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

## Gym-agnostic audit (2026-09-28)

Triggered by two live bugs the user found on the dev twin. **Method:** Gemini 3.8 Flash (high effort) located candidates in 2 calls, over the client and server. A Sonnet agent then checked every claim against the code: 26 claims plus 7 extra findings, 9 rejected. Only the verified items are listed here. Line numbers are as of `ffacc17`.

| # | Sev | Item | Evidence | Minimal fix |
|---|---|---|---|---|
| C3-14 | **H** | **Calendar settings toggle returns 500 "no gym specified" on 2-gym accounts** (live, C4-8). `POST /api/calendar/enable\|disable` do `getUserSettings()`, which is merged with the default gym's gym-scoped keys, then write the whole blob back with no gym. `setUserSettings` → `resolveGymStrict` throws. The client and the keys are fine: `calendar` is already account-scoped. | `server/server.js:704-708, 721-723`; `db.js:694-707, 1447-1453` | Write `{ calendar: cal }` only |
| C3-15 | **H** | **Timetable stays stale after linking or unlinking a gym** (live, reopens C3-1). The link, re-auth and unlink handlers call `loadGymContext()` + `refreshUserData()` but never refetch the timetable. The in-memory `psycleEvents` and the IndexedDB `psycleUnifiedCacheEvents:${userId}` keep the old gym set. Not the server `schedule-cache`, which is user-agnostic. | `client/src/ui/settings.js:1273-1274, 1466-1467, 1545-1547`; `timetable.js:308-309, 322, 395` | `await prefetchTimetableData(true)` after `refreshUserData`; clear or overwrite the unified cache first (unlink otherwise repaints the removed gym from cache); make sure an in-flight `isPrefetching` guard doesn't drop the call |
| C3-16 | M | `POST /api/config/import` writes the merged blob with no gym, so it gets the same 500 on 2 gyms, and on 1 gym it writes one gym's keys into whichever gym resolves. Export emits the merged blob. | `server/server.js:787, 836` | Export account keys plus a per-gym block; import with an explicit `gymId` per block |
| C3-17 | M | `refreshUserData` fetches profile, credits and eligibility with **no gym**, so `cache.profile/credits/eligibility` hold the default gym's data. The bookmark reads and `syncDetectedBookingWindow(profile)` run off it. | `client/src/main.js:918-965`; `timetable.js:1009, 2212`; `autobook.js:231` | Fan out per gym, or stop treating these as global |
| C3-18 | M | In-memory gym settings are mirrored by **position** (`linked[0]`), but `/api/my-gyms` sorts `gym_id ASC`, so `linked[0]` is jab-boxing while the server default is psycle-london. The comment claims they agree; they don't. | `client/src/ui/settings.js:1380, 1421-1425`; `db.js:717-729, 1893` | Key in-memory gym settings by `gymId`, or refetch `getSettings(gymId)` after a save |
| C3-19 | M | `POST /api/notify/booking-success` uses `resolveActiveGymId`, and none of the 4 client callers pass a gym, so a manual JAB booking gets a push titled "Psycle". | `server/server.js:341`; `client/src/api.js:950` | Send `gymId` from the client; server uses `req.body.gymId` |
| C3-20 | M | `calendar.js` keeps one global `locations_json` KV plus TTL. Gym A's refresh makes gym B's early-return, so gym B's addresses are missing from the feed until the TTL lapses. | `server/calendar.js:70-88` | Key per gym: `locations_json:${gymId}` |
| C3-21 | M | `studioLayoutCache` is keyed by bare `studioId`. A studio id that collides across gyms makes a class with fewer slots render the other gym's floor plan. | `client/src/ui/timetable.js:2443, 2493-2497` | Key `${gymId}:${studioId}` |
| C3-22 | M | Link and unlink don't regenerate the calendar snapshot, so the `.ics` keeps an unlinked gym's classes (or lacks a new gym's) until the 3-hourly cron. | `server/routes-normalized.js:214-236`; `db.js:2015` | `calendar.regenerateSnapshot` + `scheduleRefresh` on link and unlink |
| C3-23 | L | The poller's `claimKey` has no gymId (`${eventId}:${slot}`); the scheduler already uses `${gymId}:…` (WP-G). | `server/poller.js:246` | Add gymId |
| C3-24 | L | Dead gym-scoping: `cache.js activeGymSegment()` reads `sweatActiveGymId`, which nothing writes (`api.js:26` removes it). So `gymScopedKey()` returns the bare key, and `settings.js` reads the legacy `psycleCacheEvents/Meta` and `psycleActiveStudioIds` keys that nothing writes anymore (always a miss, so the Spot Maps active-studio filter never applies). No live collision. | `client/src/cache.js:30-34, 72`; `settings.js:617-618, 634, 702-703` | Delete `activeGymSegment`/`gymScopedKey`; repoint those reads at the unified `accountScopedKey` keys |
| C3-25 | L | `/api/bundles` is cached under a bare `userId:/api/bundles` (gym only in the header). A landmine for a second creditPurchase gym. | `client/src/api.js:188` | Put the gym in the cache key |
| C3-26 | L | The unscoped studio-preferences cache entry can serve stale data for 5 min after going from 2 gyms to 1. | `client/src/api.js:855-858` | Invalidate on link and unlink |
| C3-27 | L | The debug modal's "Open native booking page" hardcodes `psyclelondon.com`. | `client/src/ui/timetable.js:3698` | Build from the gym's `websiteUrl`, or hide it |
| C3-28 | L | `resolveContext` falls back to the ambient default when there's no `x-gym-id`. The client names the gym today. | `server/routes-normalized.js:85` | 400 for multi-gym accounts with no header (`resolveGymStrict` style) |
| C3-29 | L | **Calendar titles name a placeholder instructor.** Classes with no instructor (e.g. JAB Recovery) appear as `JAB: Recovery (Members) with Instructor, SW1`. Drop the "with …" clause whenever there's no real instructor name (missing, empty, or a generic placeholder like "Instructor"). Check the normalized `instructors[]` for these classes. Found by the user on the dev twin, 2026-09-28. | `server/calendar.js` (SUMMARY builder) | Omit the instructor segment when absent or placeholder; test both gyms |

**Fix log (2026-09-28).** Each row verified first (failing test or browser check), then fixed.

- [x] **C3-14** 2026-09-28. Basis: `server/test-calendar-settings-multigym.js` failed with `500 setUserSettings: no gym specified for an account linked to 2 gyms` once the default gym had a gym-scoped key. Fix: `server/server.js` `/api/calendar/enable` and `/disable` write `{ calendar }` only. Test now green.

- [x] **C3-15** (+ **C3-26**) 2026-09-28. Basis, real Chrome 154 against the local mock (no reload): unlinking JAB left 32 JAB rows and 48 Psycle rows in the timetable grid. Fix: `client/src/ui/timetable.js` `resetTimetableForGymChange()` (clears `psycleUnifiedCache*:${userId}` and memory, refetches with `force`), a generation counter that discards an in-flight fetch for the old gym set, and a queued follow-up so an explicit refresh during `isPrefetching` is no longer dropped; `client/src/ui/settings.js` `syncAfterGymSetChange()` is called from the link, re-auth and both unlink paths and also drops the unscoped `/api/studio-preferences` cache entry (C3-26). After: link JAB gives JAB 32 and Psycle 48 rows with no reload, unlink gives Psycle 48 rows only and IndexedDB holds 148 Psycle events.

- [x] **C3-29** 2026-09-28. Basis: `buildTitle` in `server/calendar.js` ended `... || 'Instructor'`, so any row with no instructor name rendered `with Instructor` (the placeholder is only in the title builder; `eventToCalendarShape` passes an empty string). Fix: `server/calendar.js` `instructorFirstName()` (empty or `Instructor`/`TBA`/`TBC`/`TBD` gives no clause) used by `buildTitle` and the description line. Test: `server/test-calendar-title.js` (both gyms, tentative prefix, no-location case).

- [x] **C4-8 Apple calendar link** 2026-09-28. Basis: `server/calendar.js buildLinks` offered `webcal://`, which Apple resolves as plain http (Wikipedia: webcal URLs are equivalent to http/https; user saw the insecure-connection prompt on the dev twin). Fix: new `webcals://` link (`buildLinks().webcals`); `client/src/ui/calendar-section.js` Apple action and the iOS onboarding button use it; Google's http form and plain `webcal` (non-Apple) unchanged. Also fixed onboarding's "Copy feed URL" reading `links.ics` (server returns `https`). Not verifiable without an Apple device: no source found that documents `webcals://` for Apple Calendar explicitly, it is the widely used secure form; the copy-URL https fallback remains. Test: `server/test-calendar-links.js`.

- [x] **C3-16** 2026-09-28. Basis: `POST /api/config/import` wrote the merged blob with no gym. Fix: `server/server.js` export v1.2.0 adds `accountSettings` + `gymSettings[{gymId, settings}]` (merged `psycleSettings` kept for older builds); import applies each block to its own gym, skips unlinked gyms and, for an old flat blob, sends its gym keys to the sole gym or skips them with a message on a multi-gym account (same for legacy spot maps and auto-book rows with no gym); returns `{ success, skipped }`. `server/db.js` `getAccountSettings/getGymSettings/splitSettingsByScope`. Client `api.importConfig` now throws on a non-OK response (it used to report success) and `settings.js` toasts the skipped notes. Test: `server/test-config-export-import.js`.

- [x] **C3-17 + C3-18** 2026-09-28. Basis (code + real Chrome via a fetch hook): `refreshUserData` called `/api/profile`, `/api/credits`, `/api/eligibility`, `/api/settings` with no `x-gym-id`, so `cache.profile` (bookmarks, the detected booking window) was the server-default gym's; `settings.js` mirrored gym settings by `getLinkedGyms()[0]` (jab-boxing, since `/api/my-gyms` sorts by gym_id) while the default is psycle-london. Fix: `client/src/main.js` `refreshUserData` fans out per linked gym (profile, credits, eligibility, settings, each naming its gym) into `cache.profilesByGym`, `cache.gymSettings`, `cache.eligibilityByGym`; new `profileForGym()`, `gymSetting()`, `setGymSettingLocal()`; `syncDetectedBookingWindow(profile, credits, gymId)` runs per rolling-weekly gym and compares against that gym's own stored values. Readers routed to the right gym: bookmarks in `timetable.js` (filter, heart toggle, which now also passes `event.gymId` to `setBookmark`) and `autobook.js`; `autoUpgradeByDefault`/`autoUpgradeKeepOriginalByDefault`/`autoBookFavourites` in `timetable.js`, `bookings.js`, `autobook.js`; `settings.js` mirrors into `cache.gymSettings[gymId]`. After: on a 2-gym reload every profile/credits/eligibility/settings request carries `x-gym-id` (jab-boxing and psycle-london), and no normalized route is called without a gym. `cache.profile` remains only as the single-gym fallback the credit arithmetic reads.

- [x] **C3-19** 2026-09-28. Basis: `server/test-booking-success-gym.js` failed with `JAB booking must be titled JAB, got "Psycle: Spot Booked"` on a 2-gym account. Fix: `server/server.js` `/api/notify/booking-success` uses `req.body.gymId` (403 if not linked; ambient fallback only when a stale client sends none); all 4 client callers send it (`client/src/ui/bookings.js`, `client/src/ui/timetable.js` x3). Test green.

- [x] **C3-20** 2026-09-28. Basis: `server/test-calendar-locations-per-gym.js` failed (gym B's `refreshLocationMap` early-returned on gym A's stamp; only `psycle-london` was fetched). Fix: `server/calendar.js` per-gym KV `locations_json:${gymId}`, `cachedLocationMap(gymId)`, and the ICS address lookup takes `{ [gymId]: map }` by the row's gym; the old global key is ignored (it cannot be attributed to a gym) and ages out unused. Test green.
- [x] **C3-22** 2026-09-28. Basis: `server/test-calendar-regen-on-link.js` failed for both link and unlink (`generatedAt` unchanged). Fix: `server/routes-normalized.js` `refreshCalendarAfterGymSetChange()` (regenerate now plus `scheduleRefresh`, only when the calendar is enabled) called from the link and unlink routes. Test green.

- [x] **C3-23** 2026-09-28. Basis: `server/test-gym-isolation.js` new check failed (`claimKey = \`${eventId}:${candidateSlot}\``). Fix: `server/poller.js` claim key is `${gymId}:${eventId}:${slot}`. Test green (22/22).
- [x] **C3-21** 2026-09-28. Fix: `client/src/ui/timetable.js` `layoutCacheKey = ${c.gymId}:${c.studioId}` for `studioLayoutCache` (read and write). Browser (local mock, 2 gyms): Psycle and JAB pick-a-spot modals both render their own floor plan (Bike 11..; B1..G10), no 4xx.
- [x] **C3-24** 2026-09-28. Basis: `sweatActiveGymId` has no writer (`api.js` removes it), `getActiveStudioIds()` had no caller, and the Spot Maps modal read legacy `psycleCacheEvents/Meta` keys nothing writes. Fix: deleted `activeGymSegment`/`gymScopedKey` (`client/src/cache.js`, `cache.test.js` rewritten), deleted the dead `getActiveStudioIds`, and `client/src/ui/settings.js` now reads `psycleUnifiedCacheEvents/Meta` via `accountScopedKey` (events narrowed to the gym by the existing `gymId` filter). Browser: Manage maps lists Psycle's 3 locations for Psycle and only SW1 for JAB.
- [x] **C3-25** 2026-09-28. Fix: `client/src/api.js getBundles` keys its SWR entry `/api/bundles?gymId=...` (same pattern as `getMembership`). Browser: IndexedDB key `1:/api/bundles?gymId=psycle-london`, request carries `x-gym-id`.
- [x] **C3-26** 2026-09-28. Done with C3-15 (`syncAfterGymSetChange` invalidates `/api/studio-preferences`).
- [x] **C3-27** 2026-09-28. Basis: the debug modal hardcoded `https://psyclelondon.com/pages/class/${event.id}` for every gym. Fix: `server/gyms.config.js` `classPageUrl` (Psycle only), exposed by `GET /api/gyms`; `client/src/ui/timetable.js` builds the link from the row's gym and omits the button when none. Browser: Psycle row links `https://psyclelondon.com/pages/class/1020`, JAB row shows no button.
- [x] **C3-28** 2026-09-28. Basis: `server/test-gym-required.js` failed with `two gyms, no header: /api/profile -> 200`. Fix: `server/routes-normalized.js resolveContext` uses `db.resolveGymStrict` (now exported) and answers `400 GYM_REQUIRED` for a multi-gym account with no `x-gym-id`; one linked gym is unchanged. Caller audit (every `api.*` use of the 25 gym-scoped routes): the merged reads (`getTimetable`, `getMetadata`, `getBookings`, `getWaitlists`) already branch on the linked-gym count and send a header per gym when there are several; found and fixed one real gap, `showCreditDetailsModal` (`client/src/main.js`) asked `/api/credits` with no gym so every badge showed the server default's credits; `setBookmark` also now passes the event's gym. Two suites that called gym routes with no header on the two-gym dev account now send `x-gym-id` (`test-regression-psycle.js`, `test-rate-limit-reads.js`). Browser, local 2-gym account: boot plus all five tabs, both credit badges, both booking modals, Manage maps and the debug modal: 0 responses with status >= 400.

**Rejected on verification** (kept so nobody re-raises them):
- `invalidateApiCache('/api/timetable')` wouldn't help, because the timetable uses its own unified key.
- The `'psycle-london'` fallbacks at `api.js:255`, `main.js:527` and `autobook.js:293` are unreachable (409 `NO_GYM_LINKED`; `gym_id` is NOT NULL).
- The credits favourites `[792]` are gated to creditPurchase gyms.
- `scheduleCache` invalidation on link is unnecessary (its key is user-agnostic).
- `getUserAutoUpgradesByEvent` runs inside `runWithGymContext`.
- The unscoped `GET /api/studio-preferences` is used only with ≤1 gym.
- Admin `gymGet` has had `?gymId=` since C3-8.
- `resolvePersistedGymId` is the intended cron fallback.
- `buildSample` is test-push text only.
- `bookmarksGymId()` is fine while only Psycle has bookmarks.
- The `gymBrand` `includes('jab')` is intentional client-side brand assets.

## U1-20-class hunt, verified 2026-10-06

Candidates from a Gemini 3.8 flash-high hunt for bugs of the same class as U1-20 (cross-gym fallback, "not loaded" treated as zero, provider-shape leakage, one global cache slot for per-gym data). Each was checked against the current code on 2026-10-06 (line numbers in the original claims were stale; checked by symbol).

**STATUS: 16 candidates checked: 1 valid, 15 invalid, 0 unclear.**

### Valid

- [x] **M: a failed per-gym fetch silently becomes "no bookings/waitlists" and wipes that gym's reminder cache — fixed 2026-10-06.** Evidence: `client/src/api.js getBookings`/`getWaitlists` return `[]` for a gym whose `/api/bookings` is `!res.ok` or throws (multi-gym branch). The merged list is saved as the offline snapshot and `bookings.js` then calls `api.syncBookings(merged)`, and `server.js POST /api/bookings/sync` calls `db.replaceBookingCache(userId, rows, allLinkedGymIds)`, which `DELETE`s every linked gym's rows first. One transient JAB 5xx therefore drops that gym's cancellation reminders and calendar rows until the next good sync, and My Bookings shows the gym as empty. **Fix:** `client/src/api.js` tracks `lastLoadedGymIds` set per call to `getBookings`/`getWaitlists`; `syncBookings` passes `gymIds: Array.from(lastLoadedGymIds)`. `server/server.js POST /api/bookings/sync` accepts `gymIds`, filters against linked gyms, and passes to `replaceBookingCache(scope)`. **Test:** `server/test-booking-sync-scope.js` (3/3 passing) — gyms with failed fetches stay untouched; legacy callers with no `gymIds` fall back to payload gyms.

### Rejected on verification

- `timetable.js` `isDataLoaded` global `cache.profile.available_credits`: already fixed, now `isCreditInventoryLoaded(cache, gymId, metered)` over per-gym `creditsByGym` (`gym-isolation.js`).
- `routes-normalized.js stampReleaseAt` default-gym profile/settings: the request gym travels via `runWithGymContext` (auth.js, `x-gym-id`) so `getUserById`/`getUserSettings` resolve the request's gym; per-class gyms skip it; MarianaTek `resolveBookingWindow` ignores the profile.
- `poller.js` raw `/profile` credit check for every gym: gated on `metered && !atomicSwap`, which only Psycle satisfies (JAB is `metered:false`, Aarmy is `atomicSwap:true`); the resume path uses `provider.getCredits`.
- `scheduler.js` raw `/events/:id` and CodexFit layout parsing: both sites now use `getProvider(gymId).fetchEventDetails` and normalized `slots`/`isAvailable`.
- `credits.js` global `cache.bundles`: only Psycle has `creditPurchase`, the card is clickable only for such gyms, and it is reset on refresh; latent only if a second purchasable gym is enabled.
- `bookings.js` upgrade lookups by `booking_id` (3 sites): use `findUpgradeForSeat`/`findActiveUpgradeForBooking` which filter by gym (line 421 is by unique upgrade id).
- `db.js getUserAutoUpgradesByEvent`: scoped by `resolveActiveGymId` and its only caller (`calendar.js`) runs inside `runWithGymContext` per gym.
- `calendar.js` `nb.raw.slot`: no `.raw` use remains in `calendar.js`.
- `admin.js` raw CodexFit paths: now `gymProviderCall(userId, gymId, 'listBookings'/'fetchMetadata')` through the normalized adapter.
- `timetable.js` `pickStudioPrefs`/`getStudioMapInfo` bare `studioId` fallback: only allowed when no gym is named or exactly one gym is linked (`allowLegacyFallback`).
- `main.js` Settings refresh `getSettings()` with no gym: pull-to-refresh is disabled on the Settings tab, and `gymSetting()` prefers `cache.gymSettings[gymId]` over the merged blob anyway.
- `settings.js` Profile Explorer CodexFit credit fields: it is a deliberate per-gym viewer of that gym's own `.raw` payload (`getNormalizedProfile(gymId)`).
- `main.js` single `cache.bookingWindow` slot: written but never read anywhere; per-gym truth is `cache.gymSettings[gymId]`.
- `credit-allowance.js` `.count` vs JAB `/api/credits` shape: `marianatek.js getCredits` normalizes `count`/`typeId`/`expiresAt`, and `/api/credits` returns that normalized list.
