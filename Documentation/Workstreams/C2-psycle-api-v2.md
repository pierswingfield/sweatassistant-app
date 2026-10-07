# C2 — Psycle (CodexFit) API v2 compliance and efficiency

**Priority:** P0 (phase 1: broken in prod) · P1 (phase 2) · **Size:** ~4–5 days total
**Depends on:** gate G1, a live traffic capture · **Blocks:** C4 (phase 1), F in-app 3-D Secure

> **Verify first:** before changing anything for an item, confirm its basis in the code **and**, for anything user-visible, **in a real browser** (CDP :9222 or Claude for Chrome). For server-only items, use a failing test or a request. Record the evidence. If a browser check is needed and no browser is available, stop with `BLOCKED`. See [AGENT_PROTOCOL.md](AGENT_PROTOCOL.md).

Goal: the app calls only live, current CodexFit endpoints. It makes no more requests than the
Psycle website does, and its traffic looks like the website's. Scope is Psycle only. MarianaTek
is out of scope (decided 2026-09-26).

Full plan, gap analysis and rationale:
[`Archive/2026-09-26/App_API_changes.md`](../Archive/2026-09-26/App_API_changes.md).
Endpoint reference: [`Services/psycle_codexfit.md`](../Services/psycle_codexfit.md).

## Phase 0 — Validate the doc before building on it (~0.5 day)

| # | Gate | What to capture | Blocks |
|---|---|---|---|
| C2-G1 | **Network parity table.** Record the live website's calls for timetable, book, waitlist and checkout into `server/fixtures/codexfit-v2/PARITY.md`. | Browser DevTools on psycle.codexfit.com | everything below |
| C2-G2 | **Waitlist join verb.** The doc says `POST`; the code uses `PUT`. | One real waitlist join | C2-2 |
| C2-G3 | **v2 cart lifecycle.** Create cart, add lines, list payment methods, checkout, poll for finalise. | A real (cheap) purchase, or stop just before charge | C2-1 |
| C2-G4 | `/events` v2 params, pagination envelope, location filter | Timetable page load | C2-4 |
| C2-G5 | `/heartbeat` timestamp cadence and granularity | Leave the timetable open for 10 min | C2-5 |
| C2-G6 / G7 | Profile-edit route; `cart.metadata.stripe.secret` and publishable key | Profile page; the G3 capture | F (3-D Secure) |

Follow [`LIVE_VERIFICATION_PLAYBOOK.md`](../LIVE_VERIFICATION_PLAYBOOK.md) for any live write.

## Phase 1 — Fix what's broken (P0, ~1.5 days)

| # | Item | Evidence | Est. |
|---|---|---|---|
| C2-1 | ✅ **Done (2026-09-26).** Moved in-app checkout to the v2 cart — see evidence below. | `server/providers/codexfit-cart.js`, `server/routes-normalized.js` | 1 day |
| C2-2 | ✅ **Done (2026-09-26).** Join verb confirmed `PUT` (G2); leave's real bug was the ID, not the verb — see evidence below. | `server/providers/codexfit.js leaveWaitlist` | 30 min |
| C2-3 | **Rate-limit distress abort.** On CodexFit 429/403, stop the booking queue for that gym, back off, and notify the user. Today there is no handling, so the scheduler keeps hammering. | Nothing matches 429/403 in `providers/codexfit.js` or `scheduler.js` | 2–3 h |
| C2-3b | Fix the `mock.js` `/bundles` envelope. It returns a bare array, but the provider expects `{data, relations}`, so dev mode shows no bundles. [QA-11] | `server/mock.js` ~L286 vs `codexfit.js` ~L800 | 30 min |

All four items above are **done (2026-09-26)** — see below for evidence, root cause, and the fix.

### C2-1 — move in-app checkout to the v2 cart

- **Verified (before fix):** by reading `server/server.js` ~L911–996 (now removed) — the legacy
  `/api/cart/add-bundle/:bundleId`, `/api/cart/checkout/init/:bundleId` and `/api/cart/checkout/confirm`
  routes called `/cart/add_bundle/{id}`, `/cart/get_payment_methods`, `/cart/set_payment_method/{id}` and
  `/cart/ajaxCheckoutProcess` directly — all four retired upstream (per `psycle_codexfit.md` §2.6). Real
  browser check (CDP :9222, `npm run dev`, `dev@psycle.com`): Buy Credits → bundle → "Continue to
  Payment" surfaced `Couldn't load payment options` because `server/mock.js`'s matching v1 mirrors were the
  only thing keeping dev mode's checkout alive at all — against the real gym this 404s upstream. Confirmed
  by `server/test-retired-endpoint-scan.js` run with `RETIRED_SCAN_ENFORCE=1` before the fix: 2 files / 3
  patterns (`server.js`, `mock.js`).
- **Root cause:** CodexFit migrated its cart/checkout API to a RESTful v2 surface
  (`/api/customer/v2/cart/{uuid}/...`) in September 2026; the server never moved off the v1 query-param
  endpoints it replaced.
- **Fix:**
  - `server/providers/codexfit-cart.js` (new) — the v2 cart protocol only: `initCart`/`getCart`/`addLine`/
    `mutateLineQuantity`/`removeLine` (all CONFIRMED against the live capture, `server/fixtures/codexfit-v2/
    PARITY.md` G3 + `cart-v2-lifecycle.json`) and `listPaymentMethods`/`attachPaymentMethod`/`beginCheckout`/
    `finaliseCart` (UNVERIFIED live — see below).
  - `server/providers/codexfit.js` — a v2 sibling to `request()`: `requestV2()`/`url2()`, since the v2 cart
    lives at a genuinely different base path (`/api/customer/v2`, not `/api/v1/customer`) than everything
    else this adapter calls (`gyms.config.js`'s new `v2ApiBaseUrl`). Adds `initCart`/`getCart`/
    `addBundleToCart`/`removeCartLine`/`listCartPaymentMethods`/`attachCartPaymentMethod`/`finaliseCart`/
    `getOrder` as thin session-token wrappers over the cart module.
  - `server/routes-normalized.js` — `POST /cart/checkout/init/:bundleId` and `POST /cart/checkout/confirm`
    moved here from `server.js` (client contract UNCHANGED, including the `requires_action` → website
    fallback), gated on `requireCapability(gymId, 'creditPurchase')` like every other extras route, so the
    route layer stays gym-agnostic (WP-D7) — `server.js` no longer imports `./providers` at all.
  - `server/mock.js` — v2 cart handlers (`POST /cart`, `GET /cart/{uuid}`, `POST|PUT|DELETE
    /cart/{uuid}/lines[/{hash}]`, `GET /payment-methods`, `POST /cart/{uuid}/payment-method`,
    `POST /cart/{uuid}/checkout`, `POST /cart/{uuid}/finalise`) replace the v1 mirrors, matching the live
    envelope shapes exactly (no `stripe` key on a cart that's never had a line; a zero-amount `setup`
    intent once emptied again; add-line ignores `quantity` in the body).
  - Fixed a real bug found during browser verification: `req.params.bundleId` is always a string, but the
    v2 add-line body needs the numeric bundle id (mock and doc both compare/serialize it as one) —
    `server/routes-normalized.js`'s init route now `Number()`-coerces it; without this every checkout
    failed with `422 Unknown bundle`.
  - Dead code removed as part of the same change (unused even before this fix — nothing called it):
    `server.js`'s `/api/cart/add-bundle/:bundleId` route and `extractInstance()` helper, and
    `client/src/api.js`'s `addBundleToCart()`/`getCart()` (the latter pointed at a `GET /api/cart` route
    that never existed).
- **UNVERIFIED against live Psycle** (C2 hard rule — no purchase, ever): `listPaymentMethods`,
  `attachPaymentMethod`, `beginCheckout`, `finaliseCart`, and the order-status polling after finalise.
  These follow `Documentation/Services/psycle_codexfit.md` §2.5.3 exactly but that step of the live capture
  was deliberately never exercised (see `server/fixtures/codexfit-v2/PARITY.md` G3). Flagged at each
  function in `codexfit-cart.js` and again on `codexfit.js`'s `finaliseCart`/`getOrder`.
- **Tests:** `server/test-codexfit-v2-cart.js` (new, 11/11) — contract fidelity (exact method/path/body
  against the PARITY.md G3 fixture, stubbing `requestV2`) plus a full mock round-trip (fresh cart → no
  `stripe` key → add line → PaymentIntent → remove line → zero-amount SetupIntent → full checkout/init →
  confirm → `Paid`). `server/test-retired-endpoint-scan.js` now **enforces unconditionally** (the
  `RETIRED_SCAN_ENFORCE` gate and the `mock.js` exclusion are both gone) and passes with zero hits.
- **Verified (after fix), real browser:** Playwright over CDP `127.0.0.1:9222`, one tab, `npm run dev`,
  `dev@psycle.com`, all 3 client caches cleared + real reload beforehand. Buy Credits → Psycle gym card →
  bundle "CRM 5-Pack Ride Credits" → Continue to Payment → paid with a saved mock card → **"✅ Payment
  complete — 5 credits added to your account."** Network trace: `GET /api/bundles` 200 → `POST
  /api/cart/checkout/init/792` 200 `{success:true, instance, methods:[...]}` → `POST
  /api/cart/checkout/confirm` 200 `{status:"paid", orderId:9000635}`.

### C2-2 — waitlist join/leave verb + id

- **Verified (before fix):** a live capture (`server/fixtures/codexfit-v2/waitlist-v1-join-leave.json`,
  gate G2) showed join is `PUT /waitlists/{eventId}` (matching the code — the doc's `POST` claim was
  wrong, now corrected in `psycle_codexfit.md`) but **leave is `DELETE /waitlists/{waitlistRowId}`**, a
  different id than the event id `server/providers/codexfit.js leaveWaitlist()` was using: joining event
  217095 returned `waitlist.id: 300480`, and the real site's leave call was `DELETE /waitlists/300480`,
  never `DELETE /waitlists/217095`. A failing test (`server/test-waitlist-verbs.js`, written first)
  reproduced this against the pre-fix code: stubbing `request()` and calling
  `provider.leaveWaitlist('217095', ...)` sent `DELETE /waitlists/217095` — the wrong id.
- **Root cause:** the doc and the adapter both assumed an event's waitlist join/leave used the same id.
  They don't — an event can be waitlisted by many customers, each with their own row id, and CodexFit's
  leave verb only accepts that row id.
- **Fix:** `server/providers/codexfit.js leaveWaitlist(eventId, session)` (~L706) keeps its existing
  `eventId`-based signature — the shared interface in `base.js`, and the one MarianaTek's own
  `leaveWaitlist` already uses for an analogous id mismatch — but now resolves the row internally via
  `listWaitlists()` before issuing the `DELETE`, exactly mirroring MarianaTek's existing pattern. No route
  or client contract change was needed for this half.
  - A second, genuinely separate bug surfaced verifying this in the browser: `client/src/ui/timetable.js`
    (~L1201) read `waitlistEntry.id` — a field that has never existed on a `NormalizedBooking` (it's
    `bookingId`, per `base.js`'s own doc comment) — so `waitlistId` was always `undefined` and the "Leave
    WL" button never rendered at all; the UI silently fell back to a disabled "On Waitlist" pill. Fixed to
    pass `event.id` (the class event id the provider's `leaveWaitlist` now correctly expects), not any
    field off the waitlist entry.
  - `server/mock.js` gained waitlist handlers for the first time (`PUT`/`DELETE`/`GET /waitlists`) — there
    were none before; `GET /waitlists` fell through to the generic `[]` default and `PUT`/`DELETE` silently
    no-op'd `{ok:true}` with no state change, which is exactly the kind of gap that would have hidden this
    bug's mock-mode reproduction.
- **Tests:** `server/test-waitlist-verbs.js` (new, 5/5) — join sends `PUT /waitlists/{eventId}`; leave
  resolves the row id via `listWaitlists()` and DELETEs that, not the event id; leave with no matching
  entry no-ops (no DELETE) rather than guessing; a full mock round-trip (join → row id differs from event
  id, same as live → leave by event id → entry gone); and a regression guard that a direct `DELETE
  /waitlists/{eventId}` (the pre-fix behaviour) does NOT remove the real row in the mock.
- **Verified (after fix), real browser:** same CDP session as C2-1 above, continuing in the Class
  Timetable tab. A full/waitlistable class's "Join Waitlist" button → clicked → `POST /api/waitlist/join`
  200 `{ok:true}` → a re-fetched `GET /api/waitlists` now showed `{bookingId:"300000", eventId:"1021", ...}`
  (the **row id**, distinct from the event id, exactly as live) → the "Leave WL" button was now visible
  (proving the timetable.js client fix) → two-tap confirm → `POST /api/waitlist/leave` 200 `{ok:true}` →
  `GET /api/waitlists` back to `{"waitlists":[]}`, and the row reverted to "Join Waitlist".
  - **Dev-mode caveat, not part of the fix, reverted:** the mock timetable's booking-window release times
    meant nothing was "live" (bookable) on the day of this check, so no Join Waitlist button existed to
    click at all. Verification temporarily set `is_always_bookable: true` for the mock's already-full
    seed-0 events in `server/mock.js` (~L678, the one line touched), ran the browser check above, then
    reverted the file byte-for-byte (`diff` confirmed identical) before committing — not a change in this
    commit.

### C2-3 — rate-limit distress abort

- **Verified (before fix):** by reading — no code path in `providers/codexfit.js` or
  `scheduler.js` matched HTTP 429 or 403 anywhere — and by a failing test. `server/test-rate-limit-abort.js`
  was confirmed red against the pre-fix code via a temporary `git stash` of the fix commit's files: all 4
  cases failed with `scheduler._resetRateLimitBackoffForTests is not a function` (the new exports didn't
  exist yet), then passed once the stash was restored.
- **Root cause:** no normalized distress signal existed between the provider and the scheduler — a
  429/403 was indistinguishable from "slot taken externally" (`providers/codexfit.js`'s old `bookSlot()`,
  `scheduler.js`'s old `else { burn the slot }` branch), so the scheduler kept retrying through a block
  exactly as fast as it retries a normal miss.
- **Fix:**
  - `server/providers/base.js:401` adds `classifyProviderThrottle(res, data)` — gym- and
    platform-agnostic, exported so a future MarianaTek wiring can reuse it rather than reimplementing.
  - `server/providers/codexfit.js:622-636` (`bookSlot`) calls it and attaches
    `code: 'PROVIDER_RATE_LIMITED'` + `retryAfterMs` to the `NormalizedBookingResult`
    (`server/providers/normalize.js:154-176` `makeBookingResult`).
  - `server/scheduler.js:35-79` adds a per-`gymId` backoff map (`isGymRateLimited`/`applyRateLimitBackoff`,
    keyed only by `gymId`, never global — WP-D7/WP-G) plus a deduped notification helper.
  - `server/scheduler.js:392-407` (top of `executeAutoBookForClass`) skips a new attempt outright while
    the gym is backed off — no network call at all — and the slot-attempt loop breaks out of the rest of
    that class's attempts on `PROVIDER_RATE_LIMITED` instead of burning the slot.
- **403 classification rule** (documented in `base.js`'s `classifyProviderThrottle` doc comment): 429 is
  always rate-limiting. 403 is classified as rate-limiting ONLY with corroborating evidence — a
  `Retry-After` header, or throttle language in the error message (`too many requests`, `rate limit`,
  `throttle`, `temporarily blocked`, `try again later`). An ordinary 403 (wrong credit type, not eligible,
  etc.) is left as a normal failure, because CodexFit also returns 403 for plain permission errors and a
  false positive would pause a gym's whole queue over one member's routine rejection.
- **Notification:** new type `providerThrottled` (`server/notifications.js` — `DEFAULT_PREFS`,
  `buildProviderThrottled`, `notify()` switch case), not a repurposed existing type — none of the five
  existing types describe "the provider itself is refusing us", so it needed its own copy and its own
  opt-out. Deduped per-user per-gym per-day via the existing `sent_notifications` ledger
  (`db.wasNotificationSent`/`markNotificationSent`), the same convention `poller.js`'s other one-shot
  reminders use — deliberately per-user, not one global send, since that matches the existing convention
  and needs no new mechanism.
- **Test:** `server/test-rate-limit-abort.js` — 4 cases: (1) a real 429 (via a stubbed
  `CodexFitProvider.prototype.request`, exercising the actual `classifyProviderThrottle` header/body
  logic, not a shortcut) stops dispatch for that gym, backs off, and notifies exactly once even across two
  classes; (2) a second gym on a **different platform** (JAB/MarianaTek) dispatches normally while Psycle
  is backed off, proving the key is gym-scoped, not global or platform-specific; (3) an ordinary 403 does
  NOT trip the backoff; (4) a throttle-worded 403 DOES.
- **Known gap (closed 2026-09-28 by C2-3b-poller, below):** `poller.js` made its own provider calls and
  did not honour the backoff.

### C2-3b-poller — poller honours rate limits (2026-09-28)

- **Basis:** `server/test-poller-backoff.js` written first. Run against the unchanged `poller.js` it was
  red, 3 of 4: a 429 on an upgrade POST did not stop the pass (one POST per monitor), a second pass sent
  requests to the throttled gym, a 429 on `/events/:id` armed nothing, and the reminder-cache sweep read
  `/bookings` while the gym was backed off. Only the C5-1 resume path consulted `isGymRateLimited`.
- **Root cause:** the backoff map lived inside `scheduler.js` and the poller only read it in one place.
- **Fix:** new `server/rate-limit-backoff.js` is the single owner of the per-gym state
  (`isGymRateLimited`, `applyRateLimitBackoff`, `noteThrottleError`, `noteThrottleResponse`,
  `notifyRateLimited`); `scheduler.js` now imports it (same exports as before, no second copy). Poller:
  `poller.js` `handleUpgradeThrottle` (book and atomic-swap results with `PROVIDER_RATE_LIMITED`),
  `attemptUpgradeSlot` guard and catch (thrown 429 from event details), `fetchFromGym` (any raw 429),
  `executeAutoUpgradeChecks` (`gymLimited` skip, checked before the one-shot cutoff attempt is marked used),
  `resumePausedUpgrades`, `refreshBookingCaches` (skips a throttled gym, keeps its cached rows) and
  `sendBookingWindowTip`. Notification dedupe is unchanged: once per user+gym+day via `sent_notifications`.
  A 403 is still not treated as throttling on a thrown error (no body to corroborate; base.js rule).
- **Not covered:** `calendar.js` polls bookings on its own 3-hourly cron and does not consult the backoff.
- **Test:** `test-poller-backoff.js` 4/4 (429 stops the gym until expiry with the clock advanced, other gym
  continues, notification stays at one; read-path 429; sweep skip; scheduler and poller share state).

### C2-3b — mock.js `/bundles` envelope

- **Verified (before fix), real browser:** Playwright connected over CDP to `127.0.0.1:9222` (own tab,
  `http://localhost:5173`, `npm run dev`, already logged in as `dev@psycle.com` in this Chrome profile).
  Buy Credits tab → Psycle gym card → "Buy credits →" rendered `#psycle-bundles-container` with only the
  empty-state HTML comment and zero cards; `GET /api/bundles` never fired at all when the tab first
  opened (Buy Credits' first screen is a per-gym summary grid, `#psycle-credits-summary` — bundles only
  load after opening a specific gym's catalogue from its card).
- **Root cause:** `server/mock.js`'s `/bundles` handler returned the bare `bundles` array, while
  `providers/codexfit.js`'s `listBundles()` reads `data.data || []` and
  `data.relations.bundle_types` — the same by-reference envelope `/events` uses (confirmed against
  `Documentation/Services/psycle_codexfit.md` §2.1.1 and `codexfit.js`'s own doc comment on `listBundles`,
  ~L787). `data.data` on a bare array is `undefined`, so the mock always resolved to `bundles: []`, with
  no error anywhere in the chain.
- **Fix:** `server/mock.js` `/bundles` handler (~L286) now returns
  `{ data: bundles, relations: { bundle_types: [] } }`. `bundle_types` is empty because none of the dev
  fixture bundles carry a `bundle_type_id`; the client's category filter (`bundleTypeHandle()` in
  `client/src/ui/credits.js`) falls back to its text-based rule when a bundle type can't be resolved, so
  this is enough to render correctly.
- **Verified (after fix), same real-browser path:** cleared all 3 client caches (SW + CacheStorage via
  `caches.keys()`/`serviceWorker.getRegistrations()`, IndexedDB via `indexedDB.databases()`, then a real
  `page.reload()`, not a hash-route change) and repeated the same click path. `GET /api/bundles` → 200,
  body `{"bundles":[...3 items...],"bundleTypes":[]}`, and the catalogue rendered "CRM 5-Pack Ride
  Credits" (as the pinned favourite), "10-Pack Strength & Barre", and "Introductory 3-Pack All Studios" as
  cards.

## Phase 2 — Website-shaped, efficient reads (P1, ~2 days, after C4)

> **Phase 2 status (2026-10-06, all on `optimisation`, dev twin only, not merged or deployed to prod).**
> C2-4 done: 7-day-chunked ranged `/events` (see row). C2-5 rebuilt and merged (`f37e3b0`, `cd97a62`): stamp-gated refresh with ceilings (timetable 5 min on `events`, metadata 6 h, layouts 7 d); occupancy can lag up to the ceiling; MarianaTek unchanged. The first attempt was abandoned because the `events` stamp does not move on occupancy changes, and the earlier claim that the website never calls `/heartbeat` is superseded (the user observed it does). C2-6 done. MarianaTek cold-load fix (`5a014cb`, `710e7f1`: shared single-flight date-bounded parallel-paginated class list, metadata bounded to 28 days so filter lists cover that window only) and the HTTP-cache serialisation fix (`Vary: x-gym-id`, `private, no-cache`, `?gym=` on gym-scoped GETs; `cb12c58`, `1b1ac28`, pending-gym skeleton). Final cold numbers, three gyms: first data 15.4 s, first rows 16.9 s, all gyms 18.5 s, no empty flash. **Open:** prewarm (first data is still ~15 s, bounded by one slow upstream; Aarmy ~11 s over 5 pages); C7-7 stays P3, re-evaluate. Dated evidence sections: "C2-5 rebuilt", "C2-4 cold-load benchmark", "MT cold-load investigation/fix", "Aarmy analysis + first-paint".

| # | Item | Why | Est. |
|---|---|---|---|
| C2-4 | ✅ **Done (2026-10-06), REVISED same day after a live failure.** First cut (one unscoped 42-day call) passed mock tests but **502'd on the dev twin**: live, an unscoped range is 200 up to 10 days (4.2 MB/8 s) and 502 from 14 days; G4's "works to 56 days" was location-scoped, and the mock hid the limit. **Shipped:** `providers/codexfit.js fetchTimetable` makes unscoped ranged v2 `/events?filter[between]=a,b&sort=start_at` calls **chunked at 7 days** (4 calls for the client's 28 days; was 8 requests: `/locations` + one v1 call per location), fired in parallel with `Promise.allSettled`, deduped by id, relations resolved per response, `releaseAt` still stamped per request after the shared cache. `mock.js` honours `filter[between]` and 502s unscoped spans over 10 days. **Tests:** `server/test-codexfit-timetable-range.js`. Note: G4 found the website itself calls per day, so this is not website-shaped traffic. Evidence: the cold-load sections below. | Today: 1 + 7 requests covering 28–56 days. | 1 day |
| C2-5 | ✅ **Rebuilt (2026-10-06)**: heartbeat-validated freshness with hard ceilings; accepts occupancy lag up to 5 min (see section below). Supersedes the blocked first attempt. | Fewer `/events` calls (a second load inside the ceiling makes none after the TTL check). | done |
| C2-6 | ✅ **Single-flight `/profile`** (30 s memo per user) — *pulled forward into launch 2026-09-28*, done, see C2-6 section below | `getProfile`, `getEligibility` and `getCredits` each fetch it separately | 2 h |

### C2-5 rebuilt: heartbeat-validated freshness (2026-10-06, branch `optimisation-c2-5`)
Supersedes the abandoned first attempt (blocked at the gate because the `events` stamp does not move on occupancy changes). Decision (user): mirror the official website, which polls `/heartbeat` and also does not invalidate event data on occupancy changes, so **occupancy may be stale up to the ceiling, until a booking attempt**. Built: provider hook (`hasFreshnessStamps`/`getFreshnessStamps`, CodexFit only), `server/freshness.js` (memo/single-flight/timeout/negative memo), stamp-validated extension in `schedule-cache.js` with hard ceilings (timetable 5 min, metadata 6 h, studio layouts 7 d), counters on `/api/health` and `/metrics`, mock `/heartbeat`. Write-path invalidation unchanged; heartbeat failure falls back to the 60 s TTL. C7-7 (occupancy warming) is still not made unnecessary. Tests: `server/test-freshness-cache.js`.

### C2-4 cold-load benchmark (2026-10-06, dev twin only)

Does the 7-day chunking (C2-4 at `b6fd975`) make the cold timetable slower than `master`? **No: within noise.**
Method: real Chrome (Claude for Chrome, one tab) on `sweat-dev`; before each run the dev container was restarted (empties the in-process schedule cache), SW + CacheStorage + IndexedDB + localStorage cache keys were cleared (login token kept), then a fresh navigation to `/timetable`. "Rendered" = first timetable row in the DOM, measured from navigation start. Three gyms are linked (Psycle, JAB, Aarmy), so each load is 3 `/api/timetable` (28-day) + 3 `/api/metadata` calls in parallel. The gym is carried in `x-gym-id`, which the network log does not show, so per-gym times come from a separate cold in-page harness (all six calls in parallel, explicit `x-gym-id`).

| Branch | Rendered, cold, runs 1/2/3 | Median | Slowest `/api/timetable` per load | Warm 2nd load |
|---|---|---|---|---|
| `master` | 52.6 (data-arrival 52.0, render not instrumented) / 52.0 / 51.1 s | 52.0 s | 47.4-48.7 s | 4.3 s |
| `optimisation` | 47.1 / 53.8 / 54.1 s | 53.8 s | 35.6-45.5 s | not run |

Per-gym cold, parallel harness (`/api/timetable` 28 days, `/api/metadata`):

| Gym | `master` | `optimisation` |
|---|---|---|
| Psycle (CodexFit) | 12.1 s / 0.7 s | 12.4 s / 0.8 s |
| JAB (MarianaTek) | 36.4 s / 29.0 s | 40.7 s / 24.6 s |
| Aarmy (MarianaTek) | 45.5 s / 50.3 s | 41.2 s / 48.1 s |

Findings: (1) Psycle is the fastest gym on both branches (12 s cold, unchanged), so C2-4 did not slow it; the chunks are fired with `Promise.allSettled` in `providers/codexfit.js fetchTimetable`, i.e. in parallel, not sequentially. (2) The cold page is gated by the two **MarianaTek** gyms (JAB and Aarmy, 36-48 s each), whose `/timetable` and unranged `/metadata` are two separate slow upstream fetches (metadata is derived from a full class list). The first row appears about 0.6 s after the slowest gym lands. Run-to-run spread (about 5 s) is larger than any branch difference. (3) One run (`optimisation` #3, discarded and rerun) rendered "No classes match" despite all three responses arriving; not reproduced, not investigated. (4) `LOG_LEVEL=debug` per-chunk `provider call` lines were not collected because nothing pointed at Psycle.

Fix proposal (not implemented): the cold-path cost is in `providers/marianatek.js fetchTimetable`/`fetchMetadata`, not C2-4. Share one in-flight class-list fetch between `timetable|gym|range` and `metadata|gym||` (single-flight on the underlying provider call, or derive metadata from the cached timetable), and prewarm both gyms' schedule cache at boot and on the 60 s refresh.

`server/schedule-cache.js` check: the 60 s TTL is **stale-while-revalidate on request**, not a timer. `getOrFetch` serves fresh entries, serves a stale entry immediately and starts a background `single()` refresh on that request, and awaits only on a miss. There is no `setInterval`/`setTimeout` anywhere in it. Because the cache is in-process, a restart is always a cold miss.

## MT cold-load investigation (2026-10-06, read-only, no code changed)

**Method.** Dev twin with `LOG_LEVEL=debug` set temporarily in the dev `.env` (restored afterwards; nothing persistent changed), container recreated for a cold in-process cache, calls made from the signed-in Chrome tab using the page's own token (one tab, closed after).

**Where the ~40 s goes.** `providers/marianatek.js fetchTimetable` pages `/classes?page_size=100` **serially** (`while (path && pageCount < 10)`, one await per page). Each page is 2-5 s upstream (MarianaTek, about 320 KB per 100 classes). Measured cold, JAB alone: `/api/timetable` (28 days, 788 classes) = **8 serial pages, 31.9 s**; `/api/metadata` = **10 serial pages (the cap), 25.5 s**. Both gyms together, all four calls concurrent: JAB timetable 29.1 s / metadata 22.6 s; Aarmy timetable 43.6 s (478 classes, 5 pages) / metadata 47.7 s; total wall 47.7 s (= slowest call). The two routes run concurrently from the client, so wall time is the slowest of them, but upstream load is doubled and slows each page.

**Duplication: yes, and it is worse than the earlier note said.** `/api/metadata` is derived from a class list but is **not bounded**. The client calls `getMetadata({ttlMs})` with no dates (`ui/timetable.js loadMetadata`), and `fetchMetadata` builds its defaults under the keys `min_start_date`/`max_start_date`, which `fetchTimetable` never reads (it reads `startDate`/`endDate`). So the 28-day default is dead code and metadata fetches the **entire** future schedule up to the 1000-class cap (10 pages). Cache keys differ (`timetable|gym|from|to` vs `metadata|gym||`) and there is no single-flight across them, so the same class data is fetched about 18 times per gym per cold load. `schedule-cache.js` single-flights only identical keys.

**Empty grid (optimisation run 3, unreproduced).** The server cannot return an empty success: `schedule-cache.js single()` caches only a resolved fetcher result, a thrown fetch caches nothing (and falls back to a stale entry if one exists, line 91-98), and a failed page throws out of the `fetchTimetable` loop. Partial results that CAN be cached as success: (a) the 10-page cap silently truncates at 1000 classes (marianatek.js, `maxPages`), (b) a `next` link that fails `new URL()` sets `path = null` and ends the loop with a partial list (the `catch (_)` branch). Neither explains an empty grid. Most likely cause is client-side: `getTimetableProgressive` turns a failed or non-OK gym into `[]` (`merge.fail`), and `progressive-merge.js` flushes the first arrival (Psycle at about 12 s, after the 4 s grace) with the others pending; with an empty unified cache and saved default filters naming JAB/Aarmy studios the grid shows "No classes match" until the MarianaTek gyms land (35-50 s later). `applyFlush` skips only a *final* empty flush. Needs a repro with browser console and the filter state; marked unproven.

**Ranked options (not implemented; gains are estimates against the 30-48 s cold wall time).**
1. Bound `fetchMetadata` to the same window as the timetable, or better derive metadata from the already-fetched timetable via one shared in-flight class-list fetch (single-flight keyed on gym+range, metadata reads its result). Removes about half the upstream calls and the 10-page unbounded fetch. Cold JAB roughly 32 s to 32 s alone but no contention; Aarmy 48 s to about 30 s.
2. Parallel pagination: fetch page 1, read `count`, fire pages 2..N concurrently (concurrency 4). 8 serial pages (32 s) to about 8-10 s. Largest single gain; watch MarianaTek 429 (existing `rate-limit-backoff.js`).
3. Prewarm schedule cache at boot and on a timer for each enabled gym with a linked user (needs a session; per-user token). Hides the cold path entirely for the common case; effort higher.
4. First paint on 7 days, rest in background (client two-range request, or server returns first chunk). Cold first row in about 4-8 s. Complements 2.
5. MarianaTek-only longer TTL (timetable 60 s to 5-10 min) plus the existing SWR: reduces how often the cold path recurs; does not help the first load.
6. Smaller payloads: the response is about 2.5 MB for 788 classes (about 3.2 KB per event, `raw` included); stripping `raw` from the wire helps transfer and render, not the upstream wait.

**Top next step:** options 1 + 2 together (shared, bounded, parallel class-list fetch).

Dev env restored after the run (`.env` copied back, container recreated, `/api/health` ok); registry unchanged.

### MT cold-load fix: shipped to dev twin (2026-10-06, commit on `optimisation`)

**Change** (`providers/marianatek.js`, platform-level, no gym literals): one shared single-flight class-list fetch per (gym, window, filters) feeding both `fetchTimetable` and `fetchMetadata`; metadata is date-bounded (default 28 days, was the unbounded future schedule); page 1 reveals `meta.pagination.pages`, pages 2..N then go out in parallel with a cap of 4 (`CLASS_LIST_PAGE_CONCURRENCY`). Any failed page fails the whole fetch (no partial result), a 429 arms the per-gym C2-3 backoff and stops launching pages, more than 100 pages throws instead of truncating (the old silent 10-page / unparseable-`next` truncation is gone). `fetchStudioLayout` is bounded too. Tests: `server/test-marianatek-classlist.js` (8 checks); `mock-marianatek.js` now paginates (`MOCK_MT_PAGE_MS` latency knob).
**Trade-off:** metadata filter lists cover the 28-day window only; the client also harvests options from loaded events.

Cold, dev twin, container restarted before each run, 4 calls concurrent (seconds, timetable/metadata of a gym finish together):

| Run | JAB | Aarmy | Whole page (wall) |
|---|---|---|---|
| Before (baseline) | ~36-41 | ~41-46 | ~52-54 |
| After 1 | 12.3 | 23.9 | 23.9 |
| After 2 | 11.1 | 21.4 | 21.4 |
| After 3 | 9.7 | 22.8 | 22.8 |
| **After median** | **11.1** | **22.8** | **22.8** |

Aarmy stays slower (likely slower upstream pages); not investigated.

## Tests (spread across phases)

- [x] **Cart v2 contract test against the G3 fixtures** (`server/test-codexfit-v2-cart.js`, added
  2026-09-26, 11/11 passing): method/path/body assertions for init/add-line/mutate-quantity/remove/get
  against stubbed `requestV2` calls, plus a full mock round-trip exercising the same envelope shapes the
  live capture recorded.
- [x] **Contract fidelity**: request shape matches the PARITY table — asserted directly in the test above
  (e.g. add-line body is `{type:"bundle", id}` with no `quantity` key, matching G3's live capture, not the
  doc's claim).
- [x] **Waitlist verb + id test** (`server/test-waitlist-verbs.js`, added 2026-09-26, 5/5 passing): join
  is `PUT /waitlists/{eventId}`; leave resolves the waitlist row id via `listWaitlists()` and DELETEs that,
  never the event id; a regression guard that DELETEing by the event id (the pre-fix bug) does not remove
  the real row.
- [x] **Retired-endpoint scan**: `server/test-retired-endpoint-scan.js` now **enforces unconditionally**
  (2026-09-26, as part of C2-1) — the `RETIRED_SCAN_ENFORCE` gate and the `mock.js` exclusion are both
  gone (per the file's own former header comment's instructions), and it passes with zero hits: `server.js`
  no longer calls any retired v1 cart path (moved to `routes-normalized.js` + the v2 cart), and
  `server/mock.js` mirrors the v2 envelope instead.
- [x] `test-regression-codexfit-mock.js` still green (26/26 server suites + 76/76 client tests, see `npm test`
  output in this item's evidence above).

## Decision (2026-09-26)

**No `master` backport.** Prod has the same broken cart, but C2 targets `modular` only. In-app
checkout on prod stays broken until C4 ships `modular`, and users buy credits on the Psycle website
in the meantime.

## C2-7 — CodexFit `/profile` envelope not unwrapped (launch-blocking, found in C4-9 live acceptance)

**Status: live-verified on dev twin (2026-09-27).**

- **Verified (before fix), live + code:** C4-9's live acceptance run on the dev twin
  (`sweat-dev.wingfield.tech`, `test@piersj.com`) found the Psycle tab reporting "0 credits
  available — you cannot book here until you top up" and every open timetable row showing "Buy
  Credits", while `GET /api/profile` showed `raw.data.available_credits=[{count:2,...}]` and
  `stats.credits_remaining:2` for the same account. Confirmed in code: `server/providers/
  codexfit.js` `getProfile()` (~L225), `getEligibility()` (~L250) and `getCredits()` (~L274) all
  called `this.request('/profile', ...)` and read fields (`available_credits`, `booking_cutoff`,
  `id`, ...) straight off the top-level JSON body. The real `GET /api/v1/customer/profile` wraps
  the profile as `{ data: {...} }` (`server/fixtures/codexfit-v2/PARITY.md` G1 +
  `profile-v1-response.json`, captured 2026-09-26 and reconfirmed live during C4-9) — none of the
  three methods unwrapped `.data`, so every field read was `undefined` against the real gym.
  Invisible to every test because `server/mock.js`'s dev `/profile` fixture returned the profile
  bare (no envelope) — the exact same trap AGENTS.md already documents for `/events`' by-reference
  `relations` bag.
- **Root cause:** the `/profile` GET response is enveloped live; the adapter's three readers of it
  assumed it was already unwrapped.
- **Fix:**
  - `server/providers/codexfit.js` — added `unwrapProfileEnvelope(body)` (a shared helper, just
    above `httpError`): unwraps `body.data` only when it looks like the real profile object (has
    an `id`), otherwise returns the body as-is — so a bare (mock-shaped) response and a future
    upstream envelope flip both keep working, and a genuinely credit-less bare profile still
    correctly reports `canBook:false` rather than defaulting to "free". `getProfile()` (~L225),
    `getEligibility()` (~L250) and `getCredits()` (~L274) all now call it before reading fields,
    and `raw` on the returned `NormalizedProfile` is now the **unwrapped** profile object (matching
    `login()`'s existing convention, and what every client reader of `profile.raw.X` already
    assumed).
  - `server/mock.js` `/profile` handler (~L281) now returns `{ data: {...} }`, mirroring the live
    envelope, so a regression here is caught in dev mode again.
- **Every other reader of `/profile` audited** (`rg "'/profile'"` + `rg "available_credits|
  booking_cutoff|extended_cutoff"` across `server/` and `client/`):
  - `server/providers/codexfit.js resolveBookingWindow()` (~L343) and `client/src/lib.js
    detectBookingWindow()` — both read `profile.booking_cutoff`/`.extended_cutoff` off an
    already-unwrapped object (`db.getUserById().profile_json` server-side, `normalized.raw`
    client-side respectively). Both were silently fed the WRONG (enveloped) object before this fix
    — `server/auth.js:470`'s `profile_json: profile.raw ? JSON.stringify(profile.raw) : null` was
    storing the (buggy) enveloped `raw` from `getProfile()`, so a missing cutoff silently fell back
    to the base window for every tiered Psycle member. Fixed for free once `getProfile()`'s `raw`
    became the unwrapped object — no separate change needed at either call site.
  - `server/routes-normalized.js` `/api/profile` (~L485) and `/api/credits` (~L502, the
    `profile.raw.available_credits` fallback for a provider with no `getCredits`) — both read
    `.raw` off the `NormalizedProfile`; fixed the same way, no route change needed.
  - `client/src/main.js` `refreshUserData()` (~L927, `{ ...(normalized.raw || {}), ...normalized }`)
    and `client/src/ui/settings.js` Profile Explorer (`loadedProfile = res.raw || res`, ~L235) —
    both spread/read `.raw` from the client's own `/api/profile` fetch; fixed the same way, no
    client change needed. `client/src/ui/timetable.js` debug-modal reads of `event.booking_cutoff`/
    `event.extended_cutoff` (~L3508) are off the EVENT object (server-stamped `releaseAt` inputs),
    not the profile, and were never part of this bug.
  - `server/poller.js`'s auto-upgrade credit check (~L232-242) makes its own direct
    `fetchFromGym(userId, gymId, '/profile')` call (bypassing the provider's `getProfile()`
    entirely) and already unwraps manually (`profileData.data || profileData`) before caching via
    `db.cacheUserProfile()` — already correct both before and after this fix, and compatible with
    the now-enveloped mock. Not changed, but confirmed correct rather than assumed.
  - `server/admin.js` user-detail credits (~L246, `profile.available_credits`) reads the cached
    `profile_json` blob, which is only ever populated by `poller.js`'s already-correct manual
    unwrap — confirmed not affected.
  - `server/scheduler.js`, `server.js`'s `creditWarning` notifications: confirmed (`grep`) neither
    reads `/profile` or `available_credits`/`booking_cutoff` directly — not affected.
- **Redeployed to the dev twin 2026-09-27** (HEAD `49e1f7d`, same-day follow-up to the C4-9 run
  above): rsync → `docker compose up -d --build` on oracle, `unwrapProfileEnvelope` confirmed
  present in the running container. Live re-check against the same `test@piersj.com` account
  confirmed the fix: `/api/credits` returns the real 2 credits, `/api/eligibility` →
  `canBook:true`, `/api/profile` has a non-null `bookingCutoff`, and open Psycle timetable rows
  read "Quick Book" instead of "Buy Credits". Full detail in `C4-live-acceptance-and-launch.md`'s
  "C4-9 re-check — 2026-09-27 (post C2-7 redeploy)".
- **Why prod (`master`) didn't show this — Psycle didn't change the envelope, `modular`
  regressed it:** `git show master:server/server.js` (master predates the `providers/` adapter
  split entirely) shows the old raw proxy passed the **entire enveloped body through unmodified**
  (`res.json(data)`, `data.data || data` only used for the admin cache side-channel), and
  `git show master:client/src/main.js` (`refreshUserData`) did `const profile = res.data || res;`
  — the client itself unwrapped the envelope, because it was talking to the raw CodexFit response.
  When `modular`'s normalized-provider architecture was built, the unwrap step got dropped inside
  `getProfile()`/`getEligibility()`/`getCredits()`, which started reading fields directly off the
  request body on the assumption it was already bare. **This is a `modular` regression, not an
  upstream Psycle change** — the live envelope shape is unchanged from what master's client already
  handled.
- **Test:** `server/test-profile-envelope.js` (new, 7/7 passing) — fixture-driven against the
  actual sanitized live capture (`server/fixtures/codexfit-v2/profile-v1-response.json`): asserts
  `getProfile`/`getEligibility`/`getCredits`/`resolveBookingWindow` all resolve correctly against
  the enveloped live shape (confirmed to FAIL against the pre-fix code via `git stash`: `id`
  undefined, `canBook` false instead of true, 0 credits mapped instead of 1, window null instead of
  resolved), plus 3 cases proving a bare (mock-shaped) body and a genuinely credit-less bare profile
  still work exactly as before (no regression, no false-positive "free").
- **Verified (after fix), local mock browser check** (CDP `127.0.0.1:9222`, own tab, `npm run dev`,
  `dev@psycle.com`, all 3 client caches cleared + real reload): `GET /api/profile` now returns
  unwrapped fields (`bookingCutoff`/`extendedCutoff` populated, `raw.available_credits` reachable);
  `GET /api/eligibility` → `{"canBook":true}`; `GET /api/credits` → 4 real credit-type entries.
  Header badge reads `Psycle 18 cr` (non-zero); Timetable tab: every open row's primary button
  count is `{"⚡︎Quick Book":4}` — **zero "Buy Credits" buttons**, matching the mock's non-zero
  balance. `npm test`: 33/33 server suites, 86/86 client tests. `npm run build:client`: clean.
- **Not deployed.** Per this item's own instructions — the orchestrator redeploys and re-checks
  live against `sweat-dev.wingfield.tech` after review.

## C2-6 — single-flight `/profile` (pulled forward into launch 2026-09-28) — DONE 2026-09-28

- **Basis (verified before changing):** `server/test-profile-singleflight.js` written first; against the
  old code, 12 concurrent mixed calls made 12 upstream `/profile` fetches and 3 sequential calls made 3
  (`12 !== 1`, `3 !== 1`).
- **Root cause:** `getProfile`, `getEligibility` and `getCredits` in `providers/codexfit.js` each called
  `this.request('/profile', ...)` themselves.
- **Fix:** `providers/codexfit.js` `_fetchProfile` / `_profileFor` / `invalidateProfile` (30 s memo,
  `PROFILE_MEMO_TTL_MS`), constructor state per adapter. Key is `gymId|accessToken`, so it is never
  shared across users or gyms. Concurrent callers share one in-flight promise. Only successful bodies are
  kept; a failure clears the in-flight slot and stores nothing. A generation counter means a write that
  lands mid-flight is not overwritten by the older result. The memo lives in the adapter, so every caller
  (routes, scheduler, poller, calendar) gets it without changes.
- **Invalidation (inside the adapter, so all callers are covered):** `bookSlot`, `cancelBooking` (and so
  `swapSpots`), `finaliseCart`, `getOrder` (credits land when the order settles, which is observed there),
  `updateProfile`. Bookmarks are metafields and do not touch the credit inventory or cutoffs, so they do not invalidate.
- **Tests:** `server/test-profile-singleflight.js` (7 checks: N concurrent -> 1 fetch; memo hit; two users
  -> 2 fetches; invalidation after book / cancel / updateProfile / swap; mid-flight write; failures not
  cached). `test-profile-envelope.js` now drops the memo between its checks (it reuses one token with
  different bodies).
- **MarianaTek:** does *not* have the same pattern. `getProfile` (`/me/account`), `getCredits`
  (`/me/credits`) and `getMemberships` (`/me/memberships`) are different documents; only `getEligibility`
  fans out to two of them in parallel. Nothing to fix.

## Aarmy analysis + first-paint (2026-10-06, read-only, no code changed)

**Method.** Dev twin (`optimisation` 710e7f1), `LOG_LEVEL=debug` appended to the dev `.env` temporarily (backup copied back afterwards, container recreated, `/api/health` 200, 0 debug lines). Real Chrome (Claude for Chrome, one tab, closed after): container restarted before each run, SW + CacheStorage + IndexedDB + cache keys cleared, real navigation to `/?r=N#class-timetable`, DOM polled every 40 ms. No writes. The saved filter on this account is `gym=jab-boxing, location=48751`.

### Q1: why Aarmy looked 2x JAB: it is mostly not Aarmy
Three cold runs, ms from navigation. Requests leave the page at about 2.6-4.2 s.

| Run | `/api/timetable` response end: 1st / 2nd / 3rd | Order |
|---|---|---|
| 1 | 15.8 / 24.4 / 34.8 s | Aarmy / JAB / Psycle |
| 2 | 13.3 / 23.6 / 34.3 s | same |
| 3 | 13.1 / 22.9 / 33.2 s | same |

The three per-gym requests (and the three `/api/metadata` ones) are **serialized in the browser**: resource timing shows `requestStart` of request 2 equals `responseEnd` of request 1 (e.g. 13116 vs 13117 ms), and the server's own `request` log shows each starts only when the previous finished (11.3 s, then 8.7 s, then 10.4 s). Cause: all gyms hit the **same URL** (`/api/timetable?startDate&endDate`) and differ only by the `x-gym-id` request header. The responses carry an `ETag`, no `Cache-Control` and `Vary: Origin` only, so Chrome's HTTP cache treats them as one cacheable resource and holds the 2nd/3rd request behind the 1st (same-URL cache lock). Proof: the same three calls fired in-page with `cache: 'no-store'` on a cold server finished in **10.1 s (JAB), 10.8 s (Psycle), 11.6 s (Aarmy)**, i.e. wall 11.6 s instead of about 30 s. In-order sums also explain the earlier "JAB 11 s, Aarmy 23 s": a gym's time is its position in the queue plus its own work (about 10 s each).

Aarmy's own cost (debug `provider call` lines, parallel run): 478 classes, **5 pages of 100**, page 1 about 5-6 s, then pages 2-5 in parallel at 4.3-4.9 s, about 11 s total. JAB: 788 classes, 8 pages, 1.6-3.8 s each, about 7.5 s of upstream. Psycle: 5 chunks of 7 days, 1.1-7.5 s. Per-gym extra upstream calls are the same for both MarianaTek gyms (`/me/account`, `/me/credits` x2-3, `/me/memberships`, `/me/reservations` x2, all 0.2-1 s; no per-class, location, studio or instructor lookups); no 429s, no backoff. Aarmy pages are about 1.6x slower per 100 rows (US tenant, heavier rows). Direct probe from oracle, page 1, 28-day window:

| page_size | Aarmy | JAB |
|---|---|---|
| 100 | 4.5 s (5 pages) | 2.8 s (8 pages) |
| 250 | 6.7 s (2 pages) | 4.2 s (4 pages) |
| 500 | 17.1 s (1 page, superlinear) | 9.4 s (2 pages) |

Bigger pages do not help (cost is per row, worse at 500). Payloads are small on the wire (Aarmy 36 KB, JAB 45 KB, Psycle 843 KB, compressed `/api/timetable`).

### Q2: first paint vs full load, and what the user sees
Cold, ms from navigation (requests start at 2.6-4.2 s):

| Run | First flush (first gym lands) | First rows visible | All gyms done (chips stop spinning) |
|---|---|---|---|
| 1 | 16.1 s | 25.1 s | 35.4 s |
| 2 | 13.4 s | 24.4 s | 35.0 s |
| 3 | 13.3 s | 23.3 s | 33.8 s |

While loading: skeleton until the first flush, then per-gym header chips spin (`.is-loading`, `gym-load-state.js`), then the grid paints each gym as it lands (`progressive-merge.js`, grace 0, confirmed working: flushes at each arrival). **The empty-grid case reproduces on every run**: when Aarmy (a gym the saved filter excludes) lands first, the grid shows "No classes match the current filters" for about 10 s (13.4 s to 24.4 s) with two chips still spinning, until JAB lands and rows appear. The saved gym filter hides the partial result, and nothing tells the user more gyms are pending. Code: `client/src/ui/timetable.js` `applyFlush` (about lines 974-1002) renders the partial list and ignores `pending`; `renderTimetableGrid` has no pending-gym awareness and its empty branch is at about lines 2070-2074 (`COPY.timetable.noClasses`, `copy.js:623/997`); the skeleton guard (about line 1836) only covers `psycleEvents.length === 0`, so it does not apply once any gym has landed. Related: `normalizeStoredFilters` (about line 1804) runs once on the first partial flush with partial metadata (`storedFiltersNormalized`), so a saved "all selected" test can be judged against a partial universe.

### Q3: ranked speedups (estimates vs about 31 s from request start to all gyms)
1. **Stop the browser serializing the gym requests** (largest, tiny change): add a gym segment to the URL (`?gym=` or a path) or send `Cache-Control: no-store` / `Vary: x-gym-id` on `/api/timetable` and `/api/metadata` (server `routes-normalized.js`), or `cache: 'no-store'` in `apiFetch` for these. Measured: whole page about 31 s to about 11 s; first data about 11 s to about 10 s, first rows to about 10-11 s. Also removes a latent cross-gym HTTP-cache hazard (one shared cache entry for several gyms' responses).
2. **Empty-state fix**: while any gym is pending, show the skeleton or "Loading Aarmy..." instead of "No classes match" when the filtered result is empty. Removes the confusing 10 s blank.
3. **One-round pagination** (after 1, Aarmy about 10.5 s to about 5-6 s, JAB about 7.5 s to about 4 s): fire date windows in parallel (e.g. 4 x 7 days with page_size about 150-200) instead of page 1 then pages 2..N, or speculate the page count from the last result.
4. **Narrower first window**: 7 days first (about 120 Aarmy classes, one page, about 5 s), rest in background. First rows about 5-6 s.
5. **Prewarm** the schedule cache at boot / on a timer for enabled gyms with a linked user: hides the cold path (the cache is user-agnostic, upstream needs one session).
6. Not worth it: bigger page_size (slower per row), Aarmy-specific tuning (per-row cost is the tenant's).

Dev env restored: `.env` copied back, container recreated, `/api/health` 200, no debug lines. Registry unchanged (no deploy or exposure change).

### Fix + re-measure (2026-10-06): cross-gym cache serialisation and empty-grid
**Changes.** (1) `routes-normalized.js`: router-level `Vary: x-gym-id, Authorization` and default `Cache-Control: private, no-cache` on GETs (layout and entitlement keep their own policy), pinned by `server/test-gym-http-cache.js`. (2) `client/src/api.js apiFetch`: a gym-scoped GET also carries `&gym=<id>` in the URL, so the browser's per-URL cache lock no longer queues the gyms (`api-gym-url.test.js`). Chosen over header-only because a response header cannot help a request that is already waiting on the cache lock; the server ignores the param, so the shared schedule-cache keys (`gymId|range`) and the client cache keys (which sit above `apiFetch`) are unchanged. (3) `timetable.js` + `pending-gyms.js`: an empty filtered grid shows the skeleton while a selected gym is pending (failure counts as settled), the real empty state afterwards (`pending-gyms.test.js`).

**Cold, dev twin, container restarted + SW/CacheStorage/IndexedDB cleared + real navigation, ms from navigation (one tab):**

| Metric | Before (3 runs, median) | After (3 runs: 1 / 2 / 3, median) |
|---|---|---|
| First data (first `/api/timetable` ends) | 13.3-16.1 s (13.4 s) | 15.2 / 16.3 / 15.4 s (15.4 s) |
| First rows visible | 23.3-25.1 s (24.4 s) | 16.4 / 16.9 / 17.0 s (16.9 s) |
| All gyms loaded | 33.8-35.4 s (35.0 s) | 17.0 / 18.5 / 19.0 s (18.5 s) |
| Empty "No classes match" flash | about 10 s, every run | none in 3 runs (40 ms polling) |

Requests now start together (about 3.5-3.8 s) and all three gyms finish within about 1.5 s of each other; first data is not faster because it is bounded by the slowest-first upstream (Aarmy/JAB cold, about 11-12 s). Warm reload (server cache warm, IndexedDB cache present): 30 rows painted, no spinner, no timetable request needed within the first 7 s. Deploy note: Docker Hub 429 blocked `node:20`; deployed from a clean worktree of HEAD (the main checkout carries uncommitted H-home work) with `FROM mirror.gcr.io/library/node:20` substituted for that deploy only; repo Dockerfile unchanged.
