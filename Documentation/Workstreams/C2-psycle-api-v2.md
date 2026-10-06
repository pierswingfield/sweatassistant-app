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

| # | Item | Why | Est. |
|---|---|---|---|
| C2-4 | ✅ **Done (2026-10-06), REVISED same day after a live failure.** The first cut (one unscoped 42-day call) passed mock tests and a mock browser run but **502'd on the dev twin**: live, an unscoped range is 200 up to 10 days (4.2 MB/8 s) and 502 from 14 days; the G4 "works to 56 days" result was location-scoped, and the mock hid the limit. **Shipped design:** unscoped ranged calls chunked at **7 days** (6 calls for 42 days, 4 for the client's 28; was 1 + 7 sequential-by-location), no `/locations` call; the mock now 502s unscoped spans over 10 days. Original note follows. Timetable from **v2 `/events` in one ranged call**, capped at 42 days. **Root cause:** `fetchTimetable` did `/locations` + one v1 `/events?location=` per location (8 upstream requests, confirmed by a failing test first). **Fix:** `providers/codexfit.js fetchTimetable` makes one unscoped `requestV2('/events?filter[between]=a,b&sort=start_at')` (end exclusive; windows over 42 days chunk into consecutive 42-day calls, deduped by id); relations resolved per response; `releaseAt` still stamped per request after the shared cache. `mock.js` honours `filter[between]`. **Tests:** new `server/test-codexfit-timetable-range.js`; `npm test` 69/69 server + 465 client green (Node 20). **Browser (Claude for Chrome, caches cleared, real reload):** timetable renders Psycle and JAB rows; dev log shows exactly one `/events?filter[between]=2026-10-06,2026-11-04` upstream call. Note: G4 found the website itself calls per day, so this is not website-shaped traffic; a 42-day unscoped body is large (~3.8 MB per location live). | Today: 1 + 7 requests covering 28–56 days. The website makes one ranged call. | 1 day |
| C2-5 | ⛔ **Blocked at the gate (2026-10-06): not built.** Paired check showed the `events` stamp does NOT move when occupancy changes (event 217529 22->23->22, stamp frozen at 09:47:32Z), so it cannot invalidate an occupancy-bearing cache; see PARITY.md "C2-5 gate". The 60 s TTL stays. **C7-7 (occupancy warming poller) is therefore NOT made unnecessary.** Original item: Use **`/heartbeat`** to invalidate the shared schedule cache | Replaces the blind 60 s TTL in `schedule-cache.js`. Fewer calls, fresher data. Probably makes the old "occupancy warming poller" idea (C7-7) unnecessary. | 0.5 day |
| C2-6 | ✅ **Single-flight `/profile`** (30 s memo per user) — *pulled forward into launch 2026-09-28*, done, see C2-6 section below | `getProfile`, `getEligibility` and `getCredits` each fetch it separately | 2 h |

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
- [x] `test-regression-psycle.js` still green (26/26 server suites + 76/76 client tests, see `npm test`
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
