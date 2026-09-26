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
| C2-1 | **Move in-app checkout to the v2 cart.** `/api/cart/*` still calls the retired `/cart/add_bundle`, `get_payment_methods` and `ajaxCheckoutProcess`. Add a `codexfit-cart` helper and rewrite the bundle checkout routes. **Buy Credits is broken in prod right now.** | `server/server.js` ~L911–996 | 1 day |
| C2-2 | **Align the waitlist join verb** with the G2 result. If `PUT` is wrong, waitlist joins fail silently. | `server/providers/codexfit.js` L665 `joinWaitlist` | 30 min |
| C2-3 | **Rate-limit distress abort.** On CodexFit 429/403, stop the booking queue for that gym, back off, and notify the user. Today there is no handling, so the scheduler keeps hammering. | Nothing matches 429/403 in `providers/codexfit.js` or `scheduler.js` | 2–3 h |
| C2-3b | Fix the `mock.js` `/bundles` envelope. It returns a bare array, but the provider expects `{data, relations}`, so dev mode shows no bundles. [QA-11] | `server/mock.js` ~L286 vs `codexfit.js` ~L800 | 30 min |

## Phase 2 — Website-shaped, efficient reads (P1, ~2 days, after C4)

| # | Item | Why | Est. |
|---|---|---|---|
| C2-4 | Timetable from **v2 `/events` in one ranged call**, capped at 42 days | Today: 1 + 7 requests covering 28–56 days. The website makes one ranged call. | 1 day |
| C2-5 | Use **`/heartbeat`** to invalidate the shared schedule cache | Replaces the blind 60 s TTL in `schedule-cache.js`. Fewer calls, fresher data. Probably makes the old "occupancy warming poller" idea (C7-7) unnecessary. | 0.5 day |
| C2-6 | **Single-flight `/profile`** (30 s memo per user) | `getProfile`, `getEligibility` and `getCredits` each fetch it separately | 2 h |

## Tests (spread across phases)

- [ ] Cart v2 contract test against the G3 fixtures (`server/test-codexfit-v2-cart.js`).
- [ ] Contract fidelity: request shape matches the PARITY table.
- [ ] **Retired-endpoint scan**: a test that fails if any v1 cart path appears in `server/`.
- [ ] `test-regression-psycle.js` still green.

## Decision (2026-09-26)

**No `master` backport.** Prod has the same broken cart, but C2 targets `modular` only. In-app
checkout on prod stays broken until C4 ships `modular`, and users buy credits on the Psycle website
in the meantime.
