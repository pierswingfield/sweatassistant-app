# Unified timetable, credits correctness, and filters — proposal + TODO

Raised 2026-09-14 from a live two-gym review. Split into **done in that session**,
**a proposal that needs your call**, and **a ranked TODO**.

---

## 0a. Fixed 2026-09-15 (third and fourth live review rounds)

**Correctness**
- **Cancelling from the timetable failed** while the same action worked from My Bookings:
  `api.cancel(bookingId)` was the only write in `timetable.js` not carrying `gymId`, so a
  JAB booking id was looked up against Psycle. All seven writes in that module audited.
- **Every row read "Buy Credits" on first paint**, correcting only on a day switch. The
  per-gym credit/eligibility fan-out is fire-and-forget, so the first render fell back to
  the ACCOUNT-level value — one gym's answer on every gym's rows. "Not loaded" is now
  distinct from "zero" and answers permissively, and the timetable repaints when the data
  lands.
- **First-come-first-serve classes opened an empty spot picker.** `resolveHasMap()`
  answers TRUE for an unknown studio, and MarianaTek derives studios from classes — so an
  FCFS class could have no studio entry and fall through. The event's own `layoutFormat`
  is authoritative and is used instead. **`layoutFormat` is per CLASS, not per studio** —
  JAB's BOXING room runs both kinds, so studio-level inference is wrong for half of them.
- **Quick-book fired a second, false toast** claiming no spot map existed for a studio it
  had just booked a preferred spot in. Quick-Book and the auto-upgrade registration each
  had their own lookup; there is now one `resolveStudioPrefs(event)`.
- **`.psycle-toast.warning` had no CSS at all** — near-white text on no background. Added,
  plus a catch-all so a future variant cannot go invisible the same way.
- **Credits & Membership deep link showed "Connect a gym"** to an account with two, then
  (after the first fix) showed JAB as metered with "0 credits", because `/api/my-gyms`
  rows carry no `capabilities`. Both fixed; the catalogue is merged in.

**Behaviour and UI**
- ONE booking button, honestly labelled: "Quick Book" when it books a preferred spot or
  there is no seat map, "Book" when it opens the picker. The ⚙ is gone from quick-book
  rows; configure lives in the overflow.
- Desktop gained the overflow menu it never had — same definition as mobile, with icons.
  It measures itself and opens upward near the viewport bottom, scrolling internally if it
  fits neither way.
- Class names cleaned (`cleanClassName`): discipline prefix stripped, SHOUTING
  sentence-cased, acronyms preserved, and it refuses to strip when the remainder is not a
  name ("Barre 55" would otherwise become "55").
- Real brand identities: Psycle's AVIF wordmark on `#212121`, JAB's inline SVG on
  `#6C1F20`, on both the timetable chip and the card rail. A half-width Psycle mark swaps
  in below 1240px; the card rail always uses it (the rail is 58px).
- Responsive column cascade — see §2 for the measured breakpoints.
- My Bookings compressed from four stacked rows to two, with the instructor photo as a
  figure beside the text rather than inline in a 20px line box.
- Credits & Membership renders each gym's card as its own data lands, instead of awaiting
  both fan-outs; membership caches 10 min, credits 1 min.
- Settings: one sidebar entry per gym, Your Gyms reduced to a connection table with health
  and a real `last_authenticated_at` (not `updated_at`, which moves on any write).

## 0. Fixed 2026-09-15 (second live review round)

- **Every row said "Buy Credits" on first paint**, correcting only when you switched days.
  The per-gym credit/eligibility fan-out is fire-and-forget, so the first render fell back
  to the ACCOUNT-level value — one gym's answer applied to every gym's rows. Two fixes:
  "not loaded" is now distinct from "zero" and answers permissively (same
  unknown-defaults-ON rule as capability flags), and the timetable repaints when the
  per-gym data lands instead of waiting for a day switch to force it.
- **Status column still read "No credits available"** — the earlier shortening edit
  silently failed to match and was never applied. Now short label + full reason in the
  tooltip, and gym-scoped.
- **Cancelling from the timetable failed** while the same action worked from My Bookings:
  `api.cancel(bookingId)` was the ONE write in `timetable.js` not carrying `gymId`, so a
  JAB booking id was looked up against Psycle. Per-row actions carry their own gym.
- **Quick-book fired a second, incorrect toast** claiming no spot map existed for a studio
  it had just booked a preferred spot in. Quick-Book and the auto-upgrade registration each
  had their own prefs lookup and disagreed; there is now one `resolveStudioPrefs(event)`.
- **`.psycle-toast.warning` had no CSS**, so that toast was near-white text on no
  background. Added, plus a fallback rule for any future variant.
- **"Book" opened quick-book.** The label now states what the button does: "Quick Book"
  when it books your preferred spot, "Book" when it opens the picker or when there is no
  seat map to choose from.
- **Desktop had no overflow menu** — its extras were a lone ⚙, so a wide screen offered
  FEWER actions than a narrow one. Desktop and mobile now share one menu definition,
  including "Book (choose a spot)" as the escape hatch from Quick Book.
- **Credits & Membership re-fetched per gym on every visit.** Membership now caches for
  10 minutes and credits for 1, both invalidated on any refresh that drops the profile.

## 1. Done in this session

- **One booking button, not two.** "Quick Book" + "Book" on every row were not two
  decisions; they were one decision with an optional refinement. Now a single **Book**
  whose behaviour depends on what is known:
  | Studio state | Book does |
  |---|---|
  | No seat map published | Books any open spot |
  | Seat map + saved preferences | Books the best preferred spot |
  | Seat map, no preferences yet | Opens the picker (which saves the map, so the next is instant) |
  The **⚙** is offered only where a seat map exists, for "that exact bike".
- **Class names cleaned** (`cards.js cleanClassName`). Providers prefix the discipline
  onto every class name because their own UI has no discipline column; ours does, so the
  prefix was repeated on every row and stole width from the name. Separator-agnostic
  (`TRAIN - Upper`, `RIDE: Signature 45`, `BOXING Core & Power`), plus sentence-casing
  for SHOUTING names, preserving short acronyms. Refuses to strip when the remainder is
  not a name on its own — `Barre 55` would otherwise render as `55`.
- **Copy**: `WAITLIST OPEN` → `WAITLIST`, `Fully Booked` → `Full`, `NO CREDITS
  AVAILABLE` → `NO CREDITS` with the full reason in the tooltip.
- **Discipline pill** left-aligned and width-capped at 116px. Chips still share one
  width so class names line up, but a long label (`CONDITIONING`) no longer sets the
  width for every chip in the view.
- **Column budget** stated explicitly (see §2) instead of the browser handing width out
  in proportion to content — which is why the location column beat the class name.
- **Action column**: flush right, fixed button widths. Two earlier shapes failed and are
  documented in `styles.css` so they are not retried: content-sized flex (every button a
  different size) and one reserved grid lane per role (a row without that role left a
  122px hole before the right edge).
- **Instructor avatar** centred rather than baseline-aligned in booking cards.

---

## 2. Proposal: information hierarchy in the unified timetable

**The question the merged timetable must answer first is "whose class is this?"** — it is
the one question a single-gym timetable never had to answer, and everything else is
unchanged from a normal schedule view.

Three signals carry gym ownership today, deliberately redundant:

1. **The GYM column** — chip with logo *and* text label, column 2, immediately after time.
2. **Row tint** — a 3–3.5% wash of the gym's colour.
3. **Card rail** — in Bookings/Auto-Book, a full-height branded rail.

Colour alone is never the signal: it fails in forced-colours mode, for colour-blind
users, and in daylight on a phone.

**Column order and budget, in priority order.** Widths below are the >1240px layout;
narrower bands drop columns per the cascade after this table.

| Column | Width | Why there |
|---|---|---|
| Time | 72px fixed | The scan axis. Never wraps, never moves. |
| Gym | 96px fixed | Ownership — sized to the brand plate (92px), no more |
| Class | 28% | Widest: discipline chip + name. What you are choosing. |
| Instructor | 13% | Secondary choice factor |
| Location / Studio | 17% | Two short lines; usually constant down a gym's rows |
| Status | 112px fixed | Occupancy or a state pill |
| Actions | content | One Book + overflow; **never yields to anything** |

**The responsive cascade** (measured, not guessed — at a 1500px viewport the row used
time 72 + gym 96 + class 379 + instructor 176 + location 230 + status 112 + actions 277;
the fixed parts total 557 and the flexible three compress to about 410, so the separate
layout survives to roughly 967px of table):

| Width | What changes |
|---|---|
| >1240px | Everything separate |
| 1040–1240px | Instructor + location **merge** into one stacked two-line column; the specific studio is dropped |
| <1040px | The occupancy pill drops — the only purely informational column |
| <768px | Mobile cards |

**The rule that outranks the rest: the action buttons are always fully visible and inside
the table.** They are the only thing on a row you cannot do without, so every other column
yields to them and the table never widens past its container.

**Open question for you — grouping.** Rows are currently interleaved by time across
gyms, which is right for "what can I do at 07:30?" but means the gym column alternates
constantly. Two alternatives, neither obviously better:

- **(a) Keep time-interleaved** (current). Best for choosing a slot in your day.
- **(b) Group by gym within each day**, gym as a subheading. Best for "what's on at JAB
  today", worse for comparing a time slot across gyms.
- **(c) Time-interleaved + a sticky gym-grouped summary** at the top of each day.

Recommendation: **keep (a)** and make the gym signal stronger rather than reordering —
most sessions are "I want to train at 7am, what's available?", which (b) actively harms.
Revisit if a third gym lands.

---

## 3. TODO — ranked

### T1. Credit eligibility is not provider-driven — ✅ FIXED 2026-09-15

**What you suspected is true, and it is worse than a "any credits − 1" calculation.**

Two independent problems:

1. **`NormalizedEvent` carries no `credit_types` field at all.** `getAvailableCreditsForEvent`
   reads `event.credit_types`, finds nothing, and returns `Infinity` — so the per-class
   credit-type matching is **dead code** on the normalized client. It was written against
   the raw CodexFit event and never re-normalized during WP-D15.
2. **The "No credits" state comes from `codexfit.js getEligibility`**, which is literally
   `sum(every credit, any type) > 0`. It does not know the class, its type, or its cost.

Consequences: a class requiring **2 credits** shows as bookable on a balance of 1; a class
accepting only a specific credit type shows as bookable on a balance of the wrong type;
and a gym-wide zero balance blanks every row regardless of class.

**INVESTIGATED AND FIXED.** Psycle's public `GET /events` publishes everything needed,
on every event, and always has:

| Field | Shape | Measured on 2,482 live events |
|---|---|---|
| `required_credits` | number | 2,472 cost **1**, 5 cost **2**, 2 cost **3**, 3 cost **0** |
| `credit_types` | `[{credit_type: <id>}]` | Accepted type ids; **differs per class** |
| `accepted_credits` | `[{credit_type_id: <id>}]` | The same ids in a second shape |
| `relations.credit_types` | bag | 46 types, **11 flagged `is_guest_use_only`** |

So the "1 credit per class" assumption was wrong for 10 live classes, and guest credits —
which classes DO accept, for booking a guest in — were counted toward the account
holder's own allowance.

Implemented:
- `NormalizedEvent.credits = { required, acceptedTypeIds }`, mapped in
  `codexfit.js`. Both accepted-type shapes are read, because a list response and a
  detail response do not reliably send the same one.
- `NormalizedCredit.isGuestOnly`, excluded from the usable balance.
- `getAvailableCreditsForEvent` returns **bookable spots**, i.e. `floor(usable /
  required)` — a 2-credit class on a balance of 3 is one spot, not three.
- An ABSENT `credits` field is treated as cost 1 / any type, **not** as free: returning
  Infinity there is what let the original normalization gap silently unlock every class.
- `mock.js` now models `required_credits`, `credit_types`, `accepted_credits` and the
  `relations.credit_types` bag with a guest-only type, so this cannot go dead again
  without a test going red. `test-regression-psycle.js` asserts a >1-credit class
  survives normalization end to end.

**Still open:** `accepted_plans` (membership plan ids) is normalized nowhere. It is the
field that would answer "can this membership book this class" without a credit balance at
all — relevant when a second membership-based gym arrives.

### T2. Timetable load time — ✅ FIXED 2026-09-15

**Confirmed: slow on the second load too**, which ruled out the client cache and pointed
at the server having none at all. Measured on staging against live Psycle data:

| | Time |
|---|---|
| Cold (2,482 events, one gym) | **6,105 ms** |
| Warm | **0 ms** |
| 10 concurrent warm | **0 ms** |

A merged two-gym view paid that cold cost twice, per user, per visit.

Built `server/schedule-cache.js` — shared, user-agnostic, stale-while-revalidate, with
single-flight so N concurrent cold readers cause ONE provider call (which matters most at
a release instant). Wired into `/api/timetable` and `/api/metadata`; write paths
(`book`, `cancel`, `waitlist/*`, `swap`) invalidate their gym's entries so a booking is
visible immediately. `?refresh=1` bypasses it, and only the explicit refresh control
sets it.

**The key carries gym and date range but NO user id — deliberately.** `releaseAt` depends
on the member's own booking-window tier and is stamped per request *after* the cache;
caching the stamped result would serve one member's release times to another, which is a
correctness bug rather than a staleness trade.

`/api/health` now reports hit rate, entries and in-flight count, so the next "it feels
slow" is answerable without asking a user to time their second load.

Your stated rules for how caching should work, to build against:
- persistent across refreshes
- expire on TTL only; refresh in the background at expiry, on a completed pull, or on an
  explicit refresh press
- **shared between all users** (the schedule is not user-specific)
- the client cache follows the same TTL rules

The diagnostic that picks the fix: **is the SECOND load also slow?** Slow twice → server
cache missing (build the shared cache). Fast the second time → the client cache is not
surviving sign-in, which is a different, smaller fix.

Note the existing backlog already defers "user-agnostic schedule cache" to step 7 — this
moves it up.

### T3. Instructor photos: cache and resize

Currently served at whatever size the provider publishes (MarianaTek `large_url` for the
tooltip, CodexFit's single size for everything), fetched fresh each time. Proposal:
proxy through the server, resize to ~64px for the card avatar and ~256px for the tooltip,
cache with a 12-month TTL and an immutable URL keyed by content hash.

### T4. Filters should show and group by gym — ✅ FIXED 2026-09-15

Location and instructor dropdowns now group under a gym subheading whenever the current
options actually span more than one gym, and an ambiguous label (two gyms publishing an
identically-named entry) gets a `(GymShort)` suffix — checked against the full metadata
pool, not whatever the current day/filter happens to have narrowed to, so a label doesn't
flip disambiguated/plain as you page through days. Presentation only: the underlying
selection ids are unchanged for these two. `populateOptionsList()` and
`disambiguateGymLabel()` in `timetable.js`.

Fixing this exposed a real gap: `mergeMetadataFromEvents()` (the fallback that backfills
anything not present in the base `/api/metadata` response) never stamped `gymId` onto what
it harvested, so grouping silently did nothing for any entry sourced that way — which
turned out to be **all** of JAB's class types, since JAB's `/api/metadata` currently
returns an empty `eventTypes` array entirely. Fixed for all four harvested entity types.

**Class-type dropdown is different, and coarser than the other two on purpose (raised
2026-09-15).** It groups by gym too, but does NOT get the disambiguation suffix, and its
options are not the raw `class_type.name` — they're bucketed through `getDiscipline()`
(`cards.js`), the same coarse classifier that already renders every discipline pill on the
timetable (Boxing, Train, Recovery, PT, Workshop, Ride, Barre…). The raw class-type list
was previously one checkbox per specific JAB class type (`BOXING Core & Power`, `BOXING
Drills & Endurance`, `Small Group PT`, `RESET`, `THURSDAY THROWDOWN`, …) — far noisier than
what anyone actually filters by, and a second, independent classification of the same data
the pill already classifies. Reusing one classifier for both means they can't drift apart.
`getDiscipline()` gained `PT`, `Workshop`, and a `throwdown → Train` keyword to cover JAB's
real class types once `discipline` started reading from the right field (see the
`classroom_name` fix below). The filter-matching code (`eventsExcluding` and the main
render filter, both in `timetable.js`) buckets an event's own discipline the same way
before comparing, so a saved selection is a bucket label, not a raw class-type string — an
existing saved class-type default from before this change won't match anything until
cleared and re-saved.

**Separately found while live-testing this: `discipline` was wrong at the source for JAB
— ✅ FIXED 2026-09-15.** `marianatek.js mapClassToEvent()` read `discipline` from
`c.classroom_name` — the physical ROOM name, not a class category — because in the one
example captured when this was written, the room ("TRAIN") happened to match the class
name's own discipline prefix ("TRAIN - Chest, Back, Arms"). Confirmed against 855 live JAB
classes: 68 of them disagreed, and every one of those was `classroom_name` being wrong —
e.g. "Small Group Boxing PT" sits in a room literally called "Boxing Studio", which then
showed as the class's discipline in both the filter dropdown and the row's pill. There is
no `class_session_type` field on the live payload (checked both the list and `/classes/:id`
detail endpoints) — `class_type.name` is the only real category MarianaTek exposes, and is
now the source, falling back to `classroom_name` only if a class ever has no `class_type`
at all (no live capture has shown one). `server/test-adapters.js`'s marianatek fixture
assertion updated to match.

### T5. Toast redesign — deferred, requested 2026-09-15

Toasts lead with a literal emoji character (`✅`, `⚠️`, `❌`, `ℹ️`) glued to the message.
Replace with a designed icon set (the app already has an inline SVG set in `cards.js`),
and give the whole component a proper visual pass — spacing, elevation, a progress/dismiss
affordance, stacking behaviour for several at once.

Two things found while looking at this that are ALREADY fixed, and are worth knowing
before the redesign:
- `.psycle-toast.warning` had **no CSS rule at all**, so a warning rendered as near-white
  text on no background. Any new variant needs a matching rule; there is now a
  `:not(...)` safety net that gives an unknown variant a readable surface.
- Toast text is set with `textContent`, not `innerHTML` — keep it that way. Callers pass
  `err.message` straight from provider responses.

### T6. Refresh still takes 4–5s *(expected in part — needs a decision)*

The explicit refresh control sets `?refresh=1`, which **deliberately** bypasses the shared
server cache and goes to the provider — and a live Psycle pull is ~6s for 2,482 events.
So a slow *explicit* refresh is the feature working.

What should be improved:
- The page should paint from cache **instantly** and refresh behind that, rather than
  appearing to hang. A pull-to-refresh that blocks for 5s reads as broken even when it is
  doing exactly what was asked.
- Consider narrowing the fetched range. 2,482 events is the full published schedule;
  a visible week is ~150.
- Measure where the 6s goes: one `/events` call, or the relations resolution, or
  MarianaTek's pagination in the merged case.

### T7. Smaller items

- Occupancy pill and status column: confirm the `x / y` reading is right for
  first-come-first-serve classes, where capacity is nominal.
- `getIneligibleReason` still falls back to the account-level value when a gym has no
  entry in `cache.eligibilityByGym` — correct while it loads, but worth a
  loading state rather than a possibly-wrong answer.
