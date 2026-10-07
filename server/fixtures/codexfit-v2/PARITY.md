# CodexFit v2 — live network parity (C2 phase 0, gates G1–G7)

Captured 2026-09-26 against the real `psyclelondon.com` / `psycle.codexfit.com` in the
user's own authenticated Chrome session (CDP `127.0.0.1:9222`), per
`Documentation/Workstreams/C2-psycle-api-v2.md` and `Documentation/LIVE_VERIFICATION_PLAYBOOK.md`.
Raw captures (with tokens/PII) stayed in the session scratchpad only. Sanitized response-shape
fixtures are alongside this file in `server/fixtures/codexfit-v2/*.json`, every personal/secret
value replaced with `REDACTED_*`.

Baseline before any action: 0 bookings, 0 waitlists, 2 unused credits (ids 4974423/4974424,
credit_type 1/"Universal"), empty cart. Confirmed identical after all actions below (credits by
the same two ids, not consumed/replaced).

## G1 — Network parity table

| Flow | Method | Path | Params / body | Response envelope | Status |
|---|---|---|---|---|---|
| Timetable | GET | `/api/customer/v2/events` | `filter[between]=<start>,<end>` (single **1-day** window per call), `sort=start_at` — **no `filter[location]`** was sent | `{data[], relations{instructors,event_types,studios,locations,credit_types,plans}, booking_cutoff, extended_cutoff, booked_events, friends_booked}` | 200 |
| Waitlist join | PUT | `/api/v1/customer/waitlists/{eventId}` | — | `{success:true, waitlist:{id, customer_id, event_id, added_at, event:{...}}}` | 200 |
| Waitlist leave | DELETE | `/api/v1/customer/waitlists/{waitlistEntryId}` (the row `id` from the join response, **not** the event id) | — | `{success:true}` | 200 |
| Cart init | POST | `/api/customer/v2/cart` | `{}` | `{data:{uuid, currency, subtotal, total, lines:[], metadata:{organisation:null}}}` — **no `stripe` key at all** while empty | 200 |
| Cart add line | POST | `/api/customer/v2/cart/{uuid}/lines` | `{"type":"bundle","id":<bundleId>}` — **no `quantity` field** | `{data:{id, hash, quantity:1, line_price, ...}, message:"Added to cart"}` | 200 |
| Cart snapshot (after add) | GET | `/api/customer/v2/cart/{uuid}` | — | `metadata.stripe = {type:"payment", amount, intent: pi_…, secret: pi_…_secret_…, currency, amount_ongoing}` | 200 |
| Cart remove line | DELETE | `/api/customer/v2/cart/{uuid}/lines/{hash}` | — | `{message:"Removed from cart"}` | 200 |
| Cart snapshot (empty again) | GET | `/api/customer/v2/cart/{uuid}` | — | `metadata.stripe = {type:"setup", amount:0, intent: seti_…, secret: seti_…_secret_…}` | 200 |
| Bundles (nav/profile) | GET | `/api/v1/customer/bundles` | — | `{data:[bundle,...]}`, flat array under `data`, no `relations` | 200 |
| Bundles (buy page, collection-aware) | GET | `/api/customer/v2/product-collections?filter[handle]=offers,studio,lagree,...` and `/api/customer/v2/product-collections/{handle}` | — | not fully captured (widget internals) | 200 |
| Profile | GET | `/api/v1/customer/profile` | — | `{data:{..., booking_cutoff, extended_cutoff, available_credits:[{count, credit_type:{id,name,handle,is_guest_use_only,...}}], stats:{credits_remaining,...}}}` | 200 |
| Credits | GET | `/api/v1/customer/credits?page=1&type=unused&per_page=999` | — | `{data:[...], links, meta}` — standard Laravel pagination envelope | 200 |
| Bookings | GET | `/api/v1/customer/bookings?limit=100&page=1` | — | `{data:[], links, meta, message:null, relations:{events,instructors,event_types,studios,locations}}` | 200 |
| Book | — | — | **UNOBSERVED** — see note below | — | — |
| Cancel booking | — | — | **UNOBSERVED** — see note below | — | — |
| Heartbeat | GET | `/api/v1/customer/heartbeat` | — | `{data:{bundles, bundle-types, credit-types, events, event-type-groups, event-types, instructors, locations, plans, products, product-variants, studios, videos, videos-collections, logged-in}}` — per-resource UTC last-modified timestamps, plus a `logged-in` boolean | 200 |

**Required headers actually observed** on `psycle.codexfit.com` XHRs from the real site:
`authorization: Bearer <jwt>`, `accept: application/json`, `referer: https://psyclelondon.com/`,
`user-agent`, `sec-ch-ua*`. **`origin` and `x-organisation: [object Object]` were not present** in
the header set Playwright's CDP listener exposed for these requests — this may be a tooling
visibility limit (some browser-managed headers aren't surfaced at this interception point) rather
than proof the site omits them; flagged as a caveat, not a firm contradiction.

## G2 — Waitlist join verb — CONFIRMED, with a NEW contradiction on leave

- **Join is `PUT`, matching the code** (`server/providers/codexfit.js` `joinWaitlist()`), **contradicting `psycle_codexfit.md`** which documents `POST`. Live: `PUT /api/v1/customer/waitlists/217095` → `200 {success:true, waitlist:{id:300480, event_id:217095, ...}}`.
- **CONTRADICTS-DOC (new finding, not in the original gate description): leave targets the waitlist ENTRY id, not the event id.** The real site called `DELETE /api/v1/customer/waitlists/300480` (the `waitlist.id` from the join response) — never `DELETE /waitlists/217095`. `server/providers/codexfit.js leaveWaitlist(eventId, session)` calls `DELETE /waitlists/${eventId}`, which is wrong per this capture; per C2-2 it should take/track the waitlist row id instead (the id is available on the join response and — for existing entries — on `GET /waitlists`).
- Test class used: event 217095, Psycle Oxford Circus, Mon 28 Sep 18:30 BST (~44h out at capture time). Left immediately after capture per the plan; waitlist count confirmed back to 0 afterward.
- **Incident, caught and reversed same session:** an automated "confirm" step accidentally also matched and clicked a second, unrelated "JOIN WAITLIST" button (event 216809, Sun 27 Sep 09:00 BST, ~10.5h out — under the 24h floor). Caught within the same run via the waitlists list; left immediately (`DELETE /waitlists/300481`, the accidental entry's own row id, confirming the same leave-uses-row-id finding independently). Confirmed waitlists back to exactly the one intended entry before proceeding, then 0 after leaving that too.

## G3 — v2 cart lifecycle — CONFIRMED, with two contradictions

- Full lifecycle captured: `POST /cart` (init) → `POST /cart/{uuid}/lines` (add, cheapest **buyable** bundle: "All Access Single Credit", id 2, £29.00 — the £0 "Goodwill Studio Credit" is `is_buy_now:false` and not addable via the normal flow) → `GET /cart/{uuid}` (with Stripe PaymentIntent) → `DELETE /cart/{uuid}/lines/{hash}` (remove) → `GET /cart/{uuid}` (Stripe reverts to a zero-amount SetupIntent).
- Payment methods listing, payment-method attach, checkout, and finalise were **not** exercised — per the authorization, stopped well before any pay step. `GET /api/customer/v2/payment-methods` specifically was not called this session (would need to be initiated to see its response; deferred as it sits right before the pay step in the real flow and wasn't necessary for the cart-lifecycle gate).
- **CONTRADICTS-DOC**: `psycle_codexfit.md` §2.5.2.1 shows `metadata.stripe.secret` present on an empty cart at init. Live: empty cart has **no `stripe` key at all** (`metadata: {organisation: null}`).
- **CONTRADICTS-DOC**: §2.5.2.3 shows the add-line body including `"quantity": 1`. Live: the real site sends **no `quantity` field**; the server defaults it.
- No money moved. Full sanitized lifecycle in `server/fixtures/codexfit-v2/cart-v2-lifecycle.json`.

## G4 — `/events` v2 params & pagination — CONFIRMED, with one significant contradiction

- **CONTRADICTS-DOC**: `psycle_codexfit.md` describes "the native timetable loads 10 days... up to 42 days" via presumably ranged calls, and shows a `filter[location]` param. Live capture shows the real timetable fires **three separate single-day-range calls** on initial load (`filter[between]=2026-09-26,2026-09-27`, `...27,28`, `...28,29` — i.e. today + 2 more days), **with no `filter[location]` param at all**. Location scoping for this widget embed happens some other way (not a query param on this call) — not identified this session.
- Further days (e.g. Tuesday) are **not loaded by page-bottom scrolling** — the full page was scrolled to its bottom (confirmed via `scrollY === document.body.scrollHeight` bounds) with no new `/events` call and no Tuesday content appearing. The visible 10-tab date carousel (`SAT 26` … `MON 5`) did not respond to synthetic clicks, coordinate-based mouse clicks, or drag/swipe gestures across many attempts — the real trigger for loading additional days was not identified this session (possibly requires a genuine touch/pointer sequence with characteristics synthetic input didn't replicate, or a separate mechanism not surfaced by DOM inspection). Recorded as a known gap rather than forced further, given the residual risk of unintended interaction with unrelated page elements.
- Response envelope and per-event fields fully confirmed — see `events-v2-sample.json`. Standard Laravel pagination envelope confirmed on `/bundles`, `/credits`, `/bookings`, `/waitlists`.

## G5 — Heartbeat cadence

- Only **2** heartbeat calls were observed across the full ~10-minute passive window, **287s (~4m47s) apart**, then none for the remaining ~5m13s. The second call's timing coincides with a separate verification script that reloaded the tab partway through the window (see caveat below) — so this is likely **one fetch per page load**, not a recurring client-side timer, at least not one shorter than ~5 minutes. The response shape itself (`{data:{<resource>: <UTC last-modified ISO>, ...}, logged-in: bool}`) is confirmed regardless.
- Interesting secondary finding: `logged-in: false` on both calls despite this being a fully authenticated session elsewhere (bearer JWT used on every other endpoint) — the heartbeat call was not observed carrying an `authorization` header, so `logged-in` likely reflects a separate session-cookie mechanism the BFF/PWA doesn't use, not the JWT auth state. Worth keeping in mind if `logged-in` is ever consulted for anything.
- **Caveat**: one deliberate page reload (a final-state verification check) landed inside the passive window, so the window wasn't perfectly action-free; noted for transparency. It does not affect the response-shape finding, but does mean the cadence figure above is a lower bound on the interval, not a confirmed fixed period.

## G4 re-capture (2026-10-06) — `/events` params, range and envelope

Captured through the Claude for Chrome extension on the user's real Chrome (CDP 9222 was not listening). Read-only. Fixture: `events-v2-ranges-g4.json`. This supersedes the 2026-09-26 "location unknown, range unknown" gaps.

- **Location param found**: `filter[location.handle]=<handle>` (e.g. `oxford-circus`). The earlier capture was the multi-location page, which sends no location filter. Server-side scoping verified on single-day and ranged calls (`relations.locations` held only that handle).
- **The site still calls one day at a time**: three eager single-day calls on load (today, +1, +2), then one single-day call per date-tab click (14 tabs). `filter[between]=<start>,<end>`, `sort=start_at`; end bound is exclusive for date-only values.
- **A ranged call works**: no server cap hit at 7, 42, 43 or 56 days (all 200). The publish horizon is about 23 days (last event 2026-10-29 on 2026-10-06), so ranges beyond it return the same set. The 42-day cap in C2-4 is our own bound, not an API limit. Unpaginated: no `links`/`meta`. A 42-day location-scoped call is about 3.8 MB for 986 events.
- **Envelope**: `{data, relations}` without a token; `booking_cutoff`, `extended_cutoff`, `booked_events`, `friends_booked` appear only on authenticated calls. Every event carries `occupancy` and `capacity`.
- **Unscoped caller seen**: the page also fired an unscoped 3-day call with offset ISO bounds (`2026-10-07T00:00:00+01:00,...`). ISO-with-offset bounds are accepted.
- **Doc impact**: C2-4's "the website makes one ranged call" is wrong; it makes per-day calls. One ranged call is allowed by the API but is not website-shaped traffic, so weigh that against the 1+7 request saving.

## G5 re-capture (2026-10-06) — heartbeat

Fixture: `heartbeat-g5-2026-10-06.json`.

- **Public and unauthenticated**: a bare GET with no Authorization header returns 200. It can be polled server-side with no session.
- **Cadence: the site did not poll.** 0 site-initiated heartbeat calls in a 656 s passive window on a location timetable page. Combined with the 2026-09-26 result (calls only around page loads), there is no evidence of a recurring client timer. We choose our own polling interval.
- **Granularity**: per-resource UTC last-modified, whole seconds. Cheap to compare by string.
- **Does `events` track bookings?** `events` moved from 09:09:23Z to 09:47:32Z while two events' `occupancy` changed in the same window. Suggestive only. Before C2-5 relies on it for cache invalidation, run a longer paired check (heartbeat poll every 30 s alongside an occupancy diff) to confirm a bump on every occupancy change and no occupancy change without a bump.
- `logged-in` stays false for an authenticated user; ignore it.

## G6 — Profile-edit route — UNOBSERVED (by design)

- Located the real page: "My Profile" in the account sidebar navigates (SPA, no new network call) to `https://psyclelondon.com/pages/my-psycle#/details`, rendering a "PERSONAL DETAILS" form (First/Last name, Email, phone with country code, etc.). The form's HTML `action`/`method` are inert SPA placeholders (`GET` to the same hash URL) — the real save is wired to a JS handler, not a native submit.
- Per the instruction to prefer not to submit even a no-op resave, **no submit was attempted**, so the actual save endpoint (`server/providers/codexfit.js:827` calls `POST /account/update`, unverified per the gap analysis) remains unconfirmed against live traffic.

## G7 — `cart.metadata.stripe` — CONFIRMED (shape), publishable key source not identified

- Confirmed presence/shape only (see G3 above): a **PaymentIntent** (`type:"payment"`) once the cart has a chargeable line, a **SetupIntent** (`type:"setup"`, amount 0) once it's empty. Never present at all on a freshly-initialized cart with no line ever added.
- Where the Stripe **publishable key** (`pk_...`) comes from was not identified this session (not seen in any captured XHR; likely inlined in the bootstrap/app JS bundle, which was not inspected for this pass).

## Booking / cancel (G1 rows, G3 partial) — UNOBSERVED, by choice

No live booking was made. Rationale: the date-carousel navigation issue (G4) meant every
comfortably->48h-out class (Tuesday 29 Sep onward) was unreachable through the UI without
resorting to increasingly aggressive DOM automation, which is exactly the category of action that
had already produced one near-miss this session (the accidental <24h waitlist join, caught and
reversed — see G2). Given the explicit priority on protecting the user's 2 credits and the
diminishing value of one more parity-table row against that risk, the book/cancel flow was left
unexercised. `POST /bookings` / `DELETE /bookings/{id}` shapes in `psycle_codexfit.md` and
`server/providers/codexfit.js` are therefore still only code-verified, not live-verified, this
session.

## Final state check (before commit)

- Bookings: 0 (unchanged from baseline).
- Waitlists: 0 (both the intended and the accidental entry were left; confirmed via `GET /waitlists`).
- Credits: 2, same ids as baseline (4974423, 4974424) — untouched.
- Cart: 0 lines (the £29 test line was removed; no payment method was ever attached, no checkout/finalise call was made).
- Live write/read actions used (deliberate, beyond page navigation): waitlist join ×2 (1 intended + 1 accidental), waitlist leave ×2, cart add-line ×1, cart remove-line ×1 = **6**, well under the 40-action budget. No 429/Retry-After/CAPTCHA/unexpected-403 signal at any point.

## u1-20-barre-credits.json (2026-09-29)
Live capture (ids/counts only) of one Psycle event's credit fields, the Psycle profile `available_credits` row, and the raw JAB credit row that
ended up in `cache.profile.available_credits` when JAB was the first-linked gym. Used by `client/src/ui/credit-allowance.test.js` (U1-20);
`server/mock-marianatek.js` `/me/credits` now returns the same JAB row.

## C2-5 gate: heartbeat `events` stamp vs occupancy (2026-10-06) — FAILED

Fixture: `heartbeat-vs-occupancy-c25-2026-10-06.json`. Read-only public GETs through Claude for Chrome (one tab). Heartbeat plus a fixed 4-day Oxford Circus `/events` range (176 events), ~30 s apart.

- **The `events` stamp does not track occupancy.** Event 217529 went 22 -> 23 -> 22 (a booking, then a cancellation) at 10:03:11Z and 10:03:44Z while `events` stayed `09:47:32Z`. The stamp had also not moved for >15 min before that.
- So it likely tracks schedule edits (create/update/delete of event rows), not seat counts. A cache invalidated on it would serve stale occupancy indefinitely. **Do not build C2-5 on it.** The 60 s TTL stays.
- Limits: usable window ~2 min, not 10-15. A page `setInterval` was frozen in the background tab and tool calls cap at 45 s. One counter-example is enough to disprove "moves iff occupancy changes", but a positive case (stamp moves on schedule edits) was not observed.
- Heartbeat could still serve a *schedule-structure* signal (new/changed classes) with the TTL kept for occupancy; not pursued.

## C2-4 correction (2026-10-06): unscoped `/events` ranges 502 from ~14 days

Found by deploying C2-4 to the dev twin (Psycle rows vanished). Direct public GETs: unscoped 1d 200 (0.7 MB), 7d 200 (3.1 MB, 7 s), 10d 200 (4.3 MB, 8 s), **14d / 23d / 42d HTTP 502** (~10-14 s, upstream timeout). Location-scoped 42d is fine (oxford-circus 3.8 MB/5.8 s, clapham 0.7 MB, shoreditch 1.1 MB). The G4 "no cap up to 56 days" was location-scoped only. The adapter chunks unscoped calls at 7 days.
