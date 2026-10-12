# Auto-Book audit — 2026-10-10

## Scope

Read-only diagnosis for the Auto-Book / Quick-Book preferred-spot changes. No
booking, queue, preference, or deployment mutation was made.

## Live browser evidence

Testing Chrome extension, tab opened by the audit to
`https://sweat-dev.wingfield.tech`, signed in as the existing dev user. The
Auto-Book queue had one Aarmy Bootcamp entry. Its Edit screen visibly showed
`PREFERRED SPOTS 37458, 37457, 37456 +5 more` while the map labels were
`16`–`41`, and offered a 1–4 quantity selector although Aarmy is configured
with `maxSpotsPerClass: 1`.

## Confirmed causes

1. `client/src/ui/autobook.js` hardcodes edit quantities `[1,2,3,4]`.
2. `server/server.js` correctly rejects a requested count above the gym's static
   cap, but `client/src/api.js` returns response JSON for a failing PUT instead
   of throwing. `saveAutoBookEdit` therefore shows success, closes, and renders
   the unchanged count.
3. `renderStudioFloorPlan` produces the displayed preference summary from
   `slot.label`, but the Aarmy layout has only IDs in the saved preference path;
   its editor summary therefore leaks raw provider IDs.
4. The scheduler reads the current shared `studio_preferences` map at release,
   not a queue snapshot. Mobile setup persists that map before the final
   schedule confirmation; cancelling the later modal does not undo it.
5. Multi-spot attempts are sequential and retain partial success. Candidate
   ordering has no adjacency or proximity logic. Auto-upgrades are independent
   per booking; guest reservations are a separate, post-primary API path.

## Constraints

JAB has `selfBookingPolicy: one-per-class`; MarianaTek currently publishes a
separate one-guest allowance. Neither supports treating a requested self count
as guest count. Aarmy has a static one-self-spot cap. Any future multi-spot UI
must consume an authoritative event entitlement where available and otherwise
limit only to verified configured policy.

## Checks

`curl https://sweat-dev.wingfield.tech/api/health` returned `status: ok`.
`git diff --check` returned no errors. CDP ports 9222/9223 were unavailable;
the connected testing-Chrome extension supplied the rendered evidence above.

## Implementation checklist (updated 2026-10-10)

- [x] Truthful self-count options, rejected-save error handling, and persisted cap validation.
- [x] Spatial Auto-Book candidate planner: preferred contiguous runs, aisle-safe geometry, optional wider togetherness, proximity fallback, and partial-success sequencing.
- [ ] Scheduled named guests: separate eligibility, stored identity/outcomes, idempotency/reconciliation, cancellation grouping.
- [ ] Creation/edit and Quick-Book flow wording, count controls, navigation, and read-only confirmation maps.
- [x] Studio mobile rotation configuration and shared map rendering updates (code/test verified; changed build not browser-verified).
- [x] Preferred-editor helper/count/pan fixes (code/jsdom verified; user-facing edit summary remains a later flow item).
- [ ] Desktop and 390x844 Chrome screenshots after UI implementation (blocked until a changed build is served locally or scoped dev deployment).

## Spatial selection boundary

`prioritizeTogether` persists `bookAny: true` for a multi-spot queue. The scheduler
uses provider x/y coordinates only, requires repeated spacing before declaring
adjacency, treats a larger gap as an aisle, and never falls back outside the
preferred map when `bookAny` is false. Auto-upgrades remain per-booking; they
are not made group-aware in this phase because their normalized monitor state
has no booking-group or guest outcome model.

- [x] Scheduled named-guest backend: total-place normalization, separate self/guest eligibility, durable outcomes, guest-first cancellation edge, and ambiguous-result halt/reconciliation.

## Guest capability evidence

JAB's current MarianaTek adapter exposes one guest reservation: `maxGuestBookings`
is explicitly capped to one and `bookGuestSlot` is a one-email action. This is
an implemented adapter constraint, not evidence that every MarianaTek gym or
Aarmy forbids guests. Aarmy has no enabled guest-entitlement adapter path.
Read-only Aarmy entitlement verification remains blocked: the available Chrome
tab is signed out and macOS is locked, so no authenticated, non-mutating class
eligibility request can be made safely.

## Read-only Aarmy verification, 2026-10-10

Testing Chrome extension accessed authenticated `sweat-dev` as the user test account.
Aarmy timetable loaded with current classes and 0 displayed credits. This confirms
the linked account/session and timetable availability only; no authenticated
booking-entitlement or guest capability endpoint was exposed without entering a
booking flow, so it does not validate Aarmy guest support. No queue, preference,
booking, or cancellation mutation was made.
