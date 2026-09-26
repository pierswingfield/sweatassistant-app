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

Both items above are **done (2026-09-26)** — see below for evidence, root cause, and the fix.

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
- **Known gap, not done:** `poller.js` (auto-upgrade polling, cancellation/window reminders) makes its own
  provider calls and could hit the same distress signal, but wiring per-gym backoff into it is a distinct,
  smaller follow-up — logged here rather than folded into this pass.

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
| C2-4 | Timetable from **v2 `/events` in one ranged call**, capped at 42 days | Today: 1 + 7 requests covering 28–56 days. The website makes one ranged call. | 1 day |
| C2-5 | Use **`/heartbeat`** to invalidate the shared schedule cache | Replaces the blind 60 s TTL in `schedule-cache.js`. Fewer calls, fresher data. Probably makes the old "occupancy warming poller" idea (C7-7) unnecessary. | 0.5 day |
| C2-6 | **Single-flight `/profile`** (30 s memo per user) | `getProfile`, `getEligibility` and `getCredits` each fetch it separately | 2 h |

## Tests (spread across phases)

- [ ] Cart v2 contract test against the G3 fixtures (`server/test-codexfit-v2-cart.js`).
- [ ] Contract fidelity: request shape matches the PARITY table.
- [x] **Retired-endpoint scan**: `server/test-retired-endpoint-scan.js` (added 2026-09-26). It scans
  `server/` for `/cart/add_bundle`, `get_payment_methods` and `ajaxCheckoutProcess`. Confirmed it hits
  today (`server/server.js`'s legacy checkout routes, `~L911-996`, plus `server/mock.js`'s deliberate
  mirror of them) by running it with `RETIRED_SCAN_ENFORCE=1` — it fails, correctly, on exactly those
  hits. `run-tests.js` has no per-suite skip mechanism (discovery is by filename with no registration
  step, by design), so the file always runs but only **enforces** (exits non-zero) under
  `RETIRED_SCAN_ENFORCE=1`; the default path `npm test` uses prints the same hits as
  `PENDING C2-1: ...` and exits 0, so this doesn't turn `npm test` red for a gap that's already tracked
  as C2-1. **Enable it for real as part of C2-1**: delete the `RETIRED_SCAN_ENFORCE` gate (and the
  `mock.js` exclusion, once C2-1 also moves the mock to the v2 envelope) — see the file's own header
  comment for the exact steps.
- [x] `test-regression-psycle.js` still green (24/24 server suites, see `npm test` output below).

## Decision (2026-09-26)

**No `master` backport.** Prod has the same broken cart, but C2 targets `modular` only. In-app
checkout on prod stays broken until C4 ships `modular`, and users buy credits on the Psycle website
in the meantime.
