# App API Changes — Psycle (CodexFit) v2 Alignment Plan

**Created:** 2026-09-26 · **Scope:** Psycle London only (`psycle-london` gym, `providers/codexfit.js`).
JAB / MarianaTek is out of scope.
**Source:** the updated [Services/psycle_codexfit.md](Services/psycle_codexfit.md) (§2.1.1 v2 platform,
§2.4 heartbeat, §2.5 v2 cart, §2.6 retired v1 cart, §3.3 incremental loading).
**Status:** Plan only. Nothing here is implemented. Several doc claims are **unverified** and are
listed in §2 as validation gates. Do not start a phase until its gate has passed.

---

## 0. TL;DR — what matters, in order

| # | Change | Why | Priority |
|---|--------|-----|----------|
| 1 | Migrate in-app checkout to the **v2 cart** | Every v1 cart endpoint we call is **retired** (doc §2.6). Buy Credits is broken in production right now. | **P0: broken** |
| 2 | Confirm the **waitlist join verb** (doc: `POST`, code: `PUT`) | One of them is wrong. If it's the code, joining a waitlist fails silently (`res.ok` false). | **P0: verify** |
| 3 | Fetch the timetable from **v2 `/events`** in one ranged call, capped at 42 days | Today: 1 + 7 requests covering 28 days by default (up to 56). Website: v2, 10 days then incremental, max 42. Cuts request count and matches website traffic. | P1 |
| 4 | Use **`/heartbeat`** to invalidate the shared schedule cache | Replaces a blind 60 s TTL with the invalidation signal the website itself uses. Fewer upstream calls, fresher data. | P1 |
| 5 | Remove duplicate calls to **`/profile`** | `getProfile`, `getEligibility` and `getCredits` each fetch `/profile` separately. One fetch per request would do. | P2 |
| 6 | **3-D Secure in-app** via `cart.metadata.stripe.secret` | v2 gives us the PaymentIntent secret up front, which unblocks [3d_secure_checkout.md](Backlog/3d_secure_checkout.md). | P2 (after #1) |

Estimated effort (one person, with tests): **P0 ≈ 1.5 days**, **P1 ≈ 2 days**, **P2 ≈ 2 days**,
validation capture ≈ 0.5 day up front.

---

## 1. Gap analysis: doc vs current code

### 1.1 Compliance gaps (the app calls something wrong or retired)

| Area | Current code | Updated doc | Gap |
|------|--------------|-------------|-----|
| Add to cart | `POST /cart/add_bundle/{id}` looped `qty` times — [server.js:930](../server/server.js:930), [server.js:964](../server/server.js:964) | `POST /api/customer/v2/cart/{uuid}/lines` `{type:'bundle', id, quantity}` | **Retired endpoint.** v2 takes the quantity in one call, so the loop goes. |
| Cart identity | Server-generated `randomUUID()` sent as `instance` — [server.js:959](../server/server.js:959) | `POST /v2/cart` returns the `uuid`. Website keeps it in `localStorage['psycle-codex-cart']` with `expires_at` | Obsolete `instance` pattern. We also create a new cart for every checkout, while the website reuses one until it expires. |
| Saved cards | `GET /cart/get_payment_methods?instance=` — [server.js:971](../server/server.js:971) | `GET /v2/payment-methods` | Retired. The response shape changes from `{success, methods}` to an array. |
| Set card | `POST /cart/set_payment_method/{pm}` — [server.js:991](../server/server.js:991) | `POST /v2/cart/{uuid}/payment-method` `{payment_method}` | Retired. |
| Place order | `POST /cart/ajaxCheckoutProcess` — [server.js:996](../server/server.js:996) | `POST /v2/cart/{uuid}/checkout` then `POST /v2/cart/{uuid}/finalise` (returns 202, then poll) | Retired. Two steps now, and finalisation is asynchronous. |
| Order polling | `GET /orders/{id}` every 1 s × 40 — [server.js:1010](../server/server.js:1010) | "Poll the status endpoint with exponential backoff until `succeeded`/`paid`" | **Status endpoint not named in the doc.** Validation gate G3. |
| Legacy add-bundle | `POST /api/cart/add-bundle/:id` — [server.js:922](../server/server.js:922), [api.js:965](../client/src/api.js:965) | — | The route is dead upstream. Delete it, or reimplement it on v2 lines. |
| Waitlist join | `PUT /waitlists/{eventId}` — [codexfit.js:664](../server/providers/codexfit.js:664) (its comment says "per the doc") | `POST /waitlists/{event_id}` | Conflict. Gate G2. |
| Profile edit | `POST /account/update` — [codexfit.js:827](../server/providers/codexfit.js:827) | Not documented | Unverified path. Gate G6. Low impact (hidden Konami feature). |
| Mock | v1 cart handlers — [mock.js:291-311](../server/mock.js:291) | — | The mock still approves retired endpoints. That is why the test suite is green while production is broken. |

### 1.2 Efficiency gaps (correct, but more requests than needed)

| Area | Current | Opportunity |
|------|---------|-------------|
| Timetable | `GET /locations` + one `GET /events?location=` per location (8 requests), 28 days by default, up to 56 ([codexfit.js:337](../server/providers/codexfit.js:337), [timetable.js:374](../client/src/ui/timetable.js:374)). Measured 6.1 s cold for 2,482 events. | v2 `GET /events?filter[between]=a,b&sort=start_at`. If `filter[location]` is optional (gate G4), this is **1 request, or 1 per page**. Clamp the range to **42 days**, the website's maximum. The booking window tops out at 15 + 8 = 23 days, so nothing past 42 days is bookable anyway. |
| Booking window | Separate `/profile` read for `booking_cutoff` / `extended_cutoff` | An authenticated v2 `/events` response carries both cutoffs in its envelope, so a timetable load already has them. **Do not** put them into the shared, user-agnostic cache. See §3.2. |
| Cache freshness | `schedule-cache.js` blind 60 s TTL ([schedule-cache.js:33](../server/schedule-cache.js:33)) | Poll `GET /heartbeat` (small payload). Refetch events only when `heartbeat.events` changes. The website does exactly this. |
| Profile | `getProfile` / `getEligibility` / `getCredits` each `GET /profile` ([codexfit.js:193,218,242](../server/providers/codexfit.js:193)) | Per-user single-flight memo on `/profile`, 30 s TTL, invalidated on any write. Cuts 3 calls to 1. |
| Event detail | v1 `/events/{id}` + separate `/studios` for the layout | v2 `/events/{id}` returns `slots`, `bookings`, `valid_booking_methods`, `is_bookable_standard/extended` and full `relations` in one response. |
| Auto-upgrade poll | `fetchEventDetails` per monitor per tick ([poller.js:172](../server/poller.js:172)) | Gate each tick on `heartbeat.events` / `heartbeat.bookings`, and skip the detail fetch when unchanged. **Only if** heartbeat is granular enough (gate G5). If it changes every few seconds anyway, drop this item. |

### 1.3 "Indistinguishable from the website": what parity means here

The goal is **behavioural parity**: call the endpoints, parameters, verbs, ranges and cadence the
real site uses, so our traffic looks like normal website use and matches the upstream contract.
Explicitly **not** in scope: disguising origin (IP rotation, proxy pools, TLS fingerprint spoofing).
The server's egress IP and Node's TLS handshake will always differ from a browser. Hiding that is
evasion, not compliance.

| Parity point | Current | Target |
|--------------|---------|--------|
| API generation | v1 for events/detail/bundles, retired v1 for cart | Whatever the live site uses **per endpoint**. Gate G1 captures this. Don't assume the site moved everything to v2. |
| Timetable range | 28 to 56 days in one pass | 10-day first load plus incremental extension up to 42 days, like the carousel. Server-side, 42 days is prefetched once into the shared cache. Per user, that is still fewer upstream reads than the website makes. |
| Cart lifecycle | New cart per checkout, `qty` repeated adds | One persistent cart per user + gym (`settings.cartUuid`, replacing `cartInstanceId`), reused until `expires_at`. One `lines` POST carries `quantity`. |
| Finalise analytics | n/a | Send the **real** client's `user_agent` and `screen_resolution`, forwarded from the PWA request. Never fabricate them. |
| Headers | Static UA `Chrome/149` in [gyms.config.js:39](../server/gyms.config.js:39) | Keep the static set. Re-check against a fresh DevTools capture at each gate run and record the capture date beside it. Add `content-type: application/json` on v2 writes (doc §2.5). |
| Login | Direct `/auth/login` (the website uses multipass) | Unavoidable difference. Minimise it: log in only on 401 (already true). Never add a proactive "keep-alive" login. |
| Heartbeat | Never called | Called on the same cadence the website uses (measure it in G1). |

---

## 2. Validation plan: prove the doc before building on it

Every gate gives a **captured artefact** (HAR / JSON fixture), not a conclusion. Fixtures go in
`server/fixtures/codexfit-v2/` with tokens, emails, names and card digits redacted.

Tooling: Claude for Chrome on `psyclelondon.com` while logged in (`read_network_requests`), plus
read-only `curl` from the dev machine using the same headers as `gyms.config.js`.

| Gate | Question | Method | Risk | Blocks |
|------|----------|--------|------|--------|
| **G1** | Which endpoint and version does the live site call for each flow (timetable, event modal, book, cancel, waitlist, bookings list, profile, credits, bundles, cart)? What are the heartbeat cadence and exact params? | Drive each flow on the real site and export the network log to a **parity table** (`fixtures/codexfit-v2/PARITY.md`) | None (normal website use) | Everything |
| **G2** | Waitlist join: `POST` or `PUT`? | `OPTIONS /waitlists/{id}` (safe), then capture the real site joining a full class and leave straight away | Low: leave is penalty-free | Phase 1b |
| **G3** | v2 cart lifecycle end-to-end: the cart response shape, line `hash`, `payment-methods` shape, `checkout` response, **finalise 202 body and the status endpoint it polls** | Create a cart, add/increment/decrement/delete a line, list cards, attach a card, call `checkout`. **Stop before `finalise`.** Capture `finalise` + polling from **one real purchase the user chooses to make** on the website with DevTools open | Money: finalise only on the user's own deliberate purchase | Phase 1a |
| **G4** | v2 `/events`: is `filter[location]` optional? Page size and pagination envelope (`links.next` / `meta.last_page`)? Does `data` carry the same fields `mapEventToNormalized` reads (`required_credits`, `credit_types`, relations ids)? Anonymous vs authenticated envelope? | Read-only curl across 42 days, no filter, then with `page[size]`. Diff keys against the v1 fixture | None | Phase 2 |
| **G5** | `/heartbeat` shape and granularity: how often does `events` change on a quiet day? | Poll every 60 s for 2 h and log the diff of each timestamp | None | Phase 2 heartbeat items |
| **G6** | Profile edit path (`/account/update` vs `/profile`) | Capture the website's own profile save | Low | Phase 3 |
| **G7** | `metadata.stripe.secret`: is it a PaymentIntent secret usable with Stripe.js `confirmCardPayment`, and what is the site's Stripe publishable key? | Read from the G3 cart capture and from the site's `main.js` / network | None | Phase 3 (3DS) |

**Exit criterion:** each gate's fixture is committed and the parity table is filled in. Any doc
claim a gate disproves gets corrected in `psycle_codexfit.md` **in the same change**.

---

## 3. Implementation plan

### Phase 1a: v2 cart & checkout (P0, ≈ 1 day, needs G1 + G3)

1. Add a `CodexFitCart` helper **inside the adapter layer** (`providers/codexfit.js` or
   `providers/codexfit-cart.js`), not in `server.js`. It takes paths only; the v2 base URL is a
   new gym-config field `apiV2BaseUrl: 'https://psycle.codexfit.com/api/customer/v2'` (WP-D7:
   no absolute URLs outside config).
2. Methods: `ensureCart(session, knownUuid)` (reuse if `expires_at` is in the future, else
   `POST /cart`), `setLineQuantity(uuid, bundleId, qty)` (one `POST /lines` with `quantity`),
   `listPaymentMethods()`, `attachPaymentMethod(uuid, pm)`, `beginCheckout(uuid)`,
   `finalise(uuid, analytics)`, `pollOrder(...)` with exponential backoff (1, 2, 4, 8 s, capped
   at about 40 s total, which keeps the current UX budget).
3. Rewrite `/api/cart/checkout/init/:bundleId` and `/api/cart/checkout/confirm` to use it. Keep
   the **client contract stable**: `init` still returns `{ instance, methods }`, where `instance`
   is now the cart uuid, so `credits.js` needs no change in 1a.
4. Persist `cartUuid` (+ `cartExpiresAt`) in per-gym `settings`, replacing `cartInstanceId`
   (see [multi-gym-buy-credits.md](Backlog/multi-gym-buy-credits.md)). Clear any stale lines
   before adding, so a reused cart never charges for yesterday's abandoned item. **This is the
   one real risk of cart reuse. Test it explicitly.**
5. Delete `POST /api/cart/add-bundle/:id` and `api.addBundleToCart`, or reimplement them on v2
   if the "open website cart" fallback still needs a pre-filled cart. Decide from G1: the website
   finds its cart via `localStorage` on *its* origin, which our server cannot set, so the
   fallback most likely can't share our cart and should just deep-link to the bundle page.
6. Replace the v1 cart handlers in `mock.js` with v2 ones. Make the v1 paths return **404**, so
   the mock mirrors the retirement.

### Phase 1b: waitlist verb (P0, ≈ 30 min, needs G2)

- Set `joinWaitlist` to whichever verb G2 proves. Fix the misleading comment. Update the doc if
  the doc is the one that's wrong.

### Phase 2: efficient, website-shaped reads (P1, ≈ 2 days, needs G4 + G5)

1. **v2 timetable.** `fetchTimetable` → `GET {v2}/events?filter[between]=…&sort=start_at`,
   following pagination. Keep the existing `resolveEventRelations` path: v2 is still
   `{ data, relations }`. Fall back to v1 per-location if v2 errors, logging it as a contract
   drift warning.
2. **42-day ceiling.** Clamp `prefetchWeeks` to 6 on the server (the range the upstream call
   requests). Change the Settings dropdown to 1–6.
3. **Shared cache stays user-agnostic.** Fetch the shared timetable **anonymously** (public
   endpoint), so no user's `booking_cutoff` / `booked_events` / `friends_booked` ever enters
   `schedule-cache.js`. This preserves the invariant in AGENTS.md: `releaseAt` is stamped per
   user after the cache.
4. **Heartbeat invalidation.** A `heartbeat` fetch (single-flight, ≤ 1 per 60 s per gym)
   decides whether the cached timetable is stale, in place of a pure TTL. Keep a hard max-age
   (e.g. 15 min) as a safety net in case heartbeat lies.
5. **Profile memo.** Per `(userId, gymId)` single-flight + 30 s TTL around `GET /profile`,
   cleared by every write route (book, cancel, waitlist, checkout).
6. **v2 event detail** (optional, only if G1 shows the site uses it). Map `slots`, and read
   `is_bookable_standard/extended` into a **shadow check** against our computed `releaseAt`
   (log mismatches, don't act on them). This is a live oracle for the booking-window policy.

### Phase 3: v2-enabled features (P2, ≈ 2 days, needs G6 + G7)

1. **3-D Secure in-app.** `init` also returns `cart.metadata.stripe.secret` and the publishable
   key. The client loads Stripe.js (js.stripe.com; CSP allowance needed) and calls
   `confirmCardPayment` only when `confirm` returns `requires_action`. Full design in
   [3d_secure_checkout.md](Backlog/3d_secure_checkout.md).
2. **Profile edit path** per G6.
3. **Docs.** Update AGENTS.md "Cart API" bullet and API route table,
   `psycle_codexfit.md` (verified/unverified markers), BACKLOG.md.

---

## 4. Automated testing

`npm test` must stay the one command. New suites are picked up by filename (`server/test-*.js`).

| Suite | Type | What it pins |
|-------|------|--------------|
| `test-codexfit-v2-cart.js` (new) | Server, against v2 mock | Full lifecycle: create → reuse-if-unexpired → new-if-expired → single `lines` POST carries quantity → **stale lines cleared on reuse** → card attach → checkout → finalise 202 → backoff polling → `paid` / `failed` / `requires_action` (with stripe secret) → timeout. Client contract `{instance, methods}` unchanged. |
| `test-codexfit-contract.js` (new) | Server, fixture-driven | Feeds the **redacted live fixtures from §2** through the adapter's normalizers (v2 events page, event detail, heartbeat, cart, payment-methods). Fails if a field the normalizer reads vanishes. Optional `CODEXFIT_LIVE=1` mode does read-only GETs against the real API and diffs top-level keys against the fixtures: a drift detector, never run in CI, never writes. |
| `test-request-fidelity.js` (new) | Server, stubbed `fetch` | Records every upstream request each adapter method makes and asserts **method + path + query + required headers** against the G1 parity table. Also asserts request **budgets**: timetable cold load ≤ N (target 1 + pages), profile/credits/eligibility ≤ 1 `/profile`, heartbeat ≤ 1 per window. |
| `test-no-retired-endpoints.js` (new, or extend `test-no-gym-privilege.js`) | Source scan | Fails if `add_bundle`, `get_payment_methods`, `set_payment_method`, `ajaxCheckoutProcess` or `?instance=` appear anywhere in `server/` or `client/src/` outside comments. |
| `test-schedule-cache.js` (extend) | Server | Heartbeat unchanged → no refetch. Heartbeat changed → one refetch (single-flight holds). Heartbeat down → hard max-age still expires. Cache key and value carry no user data. |
| `test-regression-psycle.js` (extend) | Server, mock | Waitlist join uses the G2 verb. `/api/cart/add-bundle` gone or reimplemented. `prefetchWeeks > 6` is clamped. |
| `credits` client test (new, vitest) | Client | Checkout modal state machine: init → pick card → paid / failed / requires_action. Once Phase 3 lands: Stripe.js confirm path with a stubbed `Stripe()`. |
| Browser smoke (manual, TESTING.md layer 3) | Mock, then live | Buy Credits end-to-end on mock. On live: timetable, event modal, waitlist join/leave, and cart **up to** the payment step, while a network capture is **diffed against the website's** captured in G1. |

**Definition of done per phase:** `npm test` green (paste the output), the phase's parity rows in
`PARITY.md` match, the browser smoke is recorded in `Documentation/QA/browser-runs/`, and the
docs are updated in the same change.

---

## 5. Risks & open questions

1. **Finalise needs real money to validate.** Only one user-chosen real purchase can confirm the
   202 → status flow. Until then, Phase 1a ships with the polling endpoint marked unverified and
   an explicit "check your Psycle account" message on timeout.
2. **Cart reuse can double-charge** if stale lines survive. Mitigation: clear lines on reuse, plus
   a dedicated test (§4).
3. **v2 pagination** can silently truncate the timetable if `page[size]` defaults low. Follow
   `links.next` and assert the event count against v1 in the contract test.
4. **Heartbeat may be too coarse or too noisy** to help. G5 decides. The TTL fallback means a
   wrong guess costs efficiency, not correctness.
5. **Does the site still use v1 for bookings / profile / credits?** If so, **stay on v1 there**.
   Parity beats modernity. G1 decides per endpoint.
