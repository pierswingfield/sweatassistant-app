# Multi-gym readiness — what's left before JAB Boxing can be enabled

**Start here.** This is the handoff: current state, what remains, and the order to do it in.

- Per-work-package history → [PROGRESS.md](./PROGRESS.md)
- Why a given fix looks the way it does → [FINDINGS.md](./FINDINGS.md) (the original audit)
- Original plan → [PLAN.md](./PLAN.md)

Last updated **2026-09-02**. Everything below was verified by running the code, not recalled.

> **Scope changed 2026-09-02.** The original goal was "a JAB user can use the app". The
> stakeholder has since required **full Psycle parity** plus a genuinely multi-gym frontend:
> gym-neutral copy and design throughout, and **every linked gym's classes shown in parallel in
> all views**, filterable by gym in the timetable. Workstreams P1/P2 below are that new scope.

---

## The goal, and the test for it

This phase is **not** "make JAB work" by bolting MarianaTek onto CodexFit. It is: every gym is an
equal upstream service. Three layers:

| Layer | Owns | Scope |
|---|---|---|
| **Platform module** — `providers/codexfit.js`, `providers/marianatek.js` | The **protocol**: how to authenticate, fetch a timetable, book a spot, and *where* this platform exposes release times, credit types, profile metadata | Every tenant on that platform |
| **Gym config** — an entry in `gyms.config.js` | The **instance and its policy**: URLs, theme, capability flags, booking-window rule | One gym |
| **App** — everything above `providers/` | Normalized types and capability flags only | Universal |

> **The test:** delete `psycle-london` from `gyms.config.js`. Nothing outside
> `providers/codexfit.js` should break.
>
> **Corollary:** a third gym should need **zero edits outside `providers/` and `gyms.config.js`.**

`server/test-no-gym-privilege.js` enforces this by scanning source: no module-level
`getProvider(...)`, no `getProvider('literal')`, no hardcoded provider hostname, no identifier
named after a platform.

---

## Where it stands

**The isolation work is done. The parity work is not.** All 9 structural layers are closed: a JAB
user can load the app, browse a real MarianaTek timetable, and every gym-coupling defect the
original audit found is fixed and pinned by a test. What remains is a different kind of work —
**feature parity and a genuinely multi-gym UI**, plus the one item code cannot close (H).

| | Structural layer (the original audit) | Status |
|---|---|---|
| A | Data layer files every row as Psycle | ✅ WP-D6 |
| B | Caller picks the provider at import time | ✅ WP-D7 |
| C | Gym link can't hold its own identity | ✅ WP-D5 |
| D | Client speaks CodexFit natively | ✅ WP-D9/11/12/13/15 |
| E | Psycle's booking window in shared code | ✅ WP-D8 |
| F | UI assumes CodexFit's feature set | ✅ WP-D14 |
| G | Runtime state not isolated between gyms | ✅ WP-G |
| I | Scheduler only ever wakes at Psycle's Monday noon | ✅ WP-I |

Tests: **16 server suites + 44 client tests**, all passing. `npm test` runs everything.

---

## What remains, in dependency order

Five workstreams. **P1 and P2 are the new scope** (stakeholder, 2026-09-02): the frontend must be
entirely gym-neutral and able to show **every linked gym's classes in parallel in all views**,
filterable by gym in the timetable. That supersedes Q4 in PROGRESS.md, which asked whether to
build a merged view at all — the answer is yes.

| | Workstream | Blocks the flip? | Rough size |
|---|---|---|---|
| **H** | Live MarianaTek booking write path | ✅ **Done** | Verified live on production JAB account (2026-09-02) |
| **B1** | Bug: Booked classes not shown in My Bookings | Yes | ~2 hours (`bookings.js` raw field migration) |
| **B2** | Bug: Timetable truncates after ~100 classes | Yes | ~1 hour (`marianatek.js` pagination loop) |
| **B3** | Onboarding: Sequential multi-gym link flow (max 1/gym) | Yes | ~half a day (`onboarding.js`) |
| **J** | No eligibility concept — "can this account book here?" | Yes | ~half a day |
| **P1** | Parallel multi-gym views + timetable gym filter | Yes (new scope) | 2–4 days |
| **P2** | Gym-neutral copy & design audit | Yes (new scope) | ~1 day |
| **P3** | Remaining feature parity gaps (spot maps, upgrade cutoff, proxy removal) | Partly | 2–3 days |

### H — Live MarianaTek booking *(✅ Done 2026-09-02)*

**Passed live in production.** A real JAB Boxing class was successfully booked via `POST /api/book` (`POST /me/reservations`). Floor plan / spot maps and spot preferences for JAB were also verified working live.

Remaining write checks to complete: cancel within/outside penalty window, waitlist join/auto-fill, and native spot swap.

### B1 — Bug: Active bookings not shown in My Bookings *(~2 hours)*

**Found 2026-09-02.** Booked JAB classes do not render under "My Bookings > Active Bookings", and spot-upgrade chips cannot attach.
- **Root cause**: `bookings.js:58` `toLegacy()` unwraps to `nb.event.raw`, and `bookings.js:138` checks `event.start_at` (CodexFit field name) and raw fields like `event.event_type.name`. MarianaTek objects use `start_datetime`, `class_type`, etc., so `if (!event || !event.start_at) return;` silently discards every JAB booking.
- **Fix**: Migrate `bookings.js` to consume `NormalizedEvent` fields (`event.startAt`, `event.name`, `event.discipline`, `event.instructors`, `event.locationName`, `event.studioName`) directly, mirroring WP-D15.

### B2 — Bug: Only a few days of classes visible in Timetable *(~1 hour)*

**Found 2026-09-02.** Timetable only renders ~3–5 days of classes.
- **Root cause**: `providers/marianatek.js fetchTimetable()` requests a single page (`page_size=100`) without following pagination. Across multiple studios/days, 100 classes covers only a few days.
- **Fix**: Loop over MarianaTek's pagination (`data.links.next` or page counter) in `fetchTimetable()` until the requested date window is retrieved.

### B3 — Onboarding: Sequential multi-gym linking UX *(~half a day)*

**Found 2026-09-02.** Onboarding currently directs user straight to timetable after connecting one gym, requiring Settings to add a second gym.
- **Requirement**: Allow connecting multiple gyms in a row during first-run onboarding (prompt: "Add another gym" or "Continue to app").
- **Constraint**: Enforce a maximum of one per-gym account per Sweat Assistant account.

### J — There is no eligibility concept *(~half a day)*

**Raised by the stakeholder 2026-09-02**, correcting a fix made the same day. `metered` ("a class
draws down a credit balance") and `creditPurchase` ("we can sell top-ups") both exist. **"Can this
account book here at all" does not** — and it is the question that actually matters for a
membership gym.

Until 2026-09-02 the case was covered *by accident*: credit arithmetic summed an empty
`available_credits` to 0 and rendered "⚠ Insufficient Credits". Right conclusion for the JAB test
account, wrong input — it warned identically for a JAB user **with** a valid membership, which is
why it was removed. Net today: **a JAB user with no membership sees no warning and fails at the
booking attempt with no explanation.**

**Do:**
1. Add `eligibility` to `NormalizedProfile` (or a small `getEligibility()` on the provider
   contract) — at minimum `{ canBook: boolean, reason?: string, expiresAt?: string }`.
2. Implement for MarianaTek from the **existing** `getMemberships()` in `providers/marianatek.js`
   — it works and is already tested, but is **wired to no route**.
3. Implement for CodexFit as "has usable credit for this class", so the two collapse to one
   client-side question.
4. Expose on a normalized route, consume it where the credit warning used to render
   (`autobook.js`, `autoupgrade.js`, `bookings.js`, `timetable.js` book buttons).
5. **Never re-derive eligibility from credits** to shortcut this — that is the bug being fixed.

**Test:** extend `credit-allowance.test.js` (or a sibling) so a membership gym with no membership
reports `canBook: false` while a membership gym *with* one reports true — the distinction the old
code could not make.

### P1 — Parallel multi-gym views + timetable gym filter *(2–4 days)*

Today the app is **one-gym-at-a-time**: `x-gym-id` scopes every request to the active gym, and
switching reloads. The requirement is now that **all linked gyms appear together in every view**,
with a gym filter in the timetable.

This is the largest remaining piece and it changes assumptions on both sides:

**Server**
- Normalized routes need a multi-gym mode — either `GET /api/timetable?gyms=a,b` or an implicit
  "all linked gyms", fanning out per gym and merging. Per-gym failures must **degrade, not fail
  the request**: one gym's outage cannot blank the timetable.
- Every merged row must carry its `gymId`. Provider ids are **only unique within a gym**, so a
  merged list has genuine id collisions — see trap 1 and trap 11 below. This is the single
  highest-risk part of the change.
- `resolveActiveGymId()` stays for write paths (booking still targets exactly one gym).

**Client**
- Timetable: a gym filter alongside location/instructor/type, and per-row gym identification
  (badge or accent). Saved filters are already gym-keyed — a **merged** view needs a filter model
  that is not scoped to one gym, so `psycleDefaultFilters:<gymId>` needs rethinking here.
- Bookings / Auto-Book / Auto-Upgrade: merged lists, grouped or badged by gym.
- **Buy Credits Tab**: permanently visible when any linked gym supports credit purchases. Inside the tab, a gym selector / submenu allows picking which gym to buy for, filtering to only display linked gyms where `creditPurchase: true` (e.g. Psycle London present, JAB Boxing omitted).
- **Theming becomes per-row, not per-document.** `applyGymTheme()` currently stamps `data-gym` on
  `<html>` and the palette follows. With two gyms on screen there is no single active accent —
  needs a per-card scope, and a decision on what the chrome uses.
- **Capability gating becomes per-row too.** `can('bookmarks')` is a global question today; in a
  merged view the answer differs per class. Every `data-requires-capability` element and every
  `can()` call site in a list context needs auditing.
- Caches are gym-scoped by key (WP-G) — a merged view reads several and must not re-introduce a
  single global key to hold the merged result.

**Decided (D8, 2026-09-02): merged is the DEFAULT — and a single-gym account must not pay for
it.** Some users will only ever link one gym, so **n=1 must look and behave exactly as it does
today**: no gym badges, no gym filter, no extra fan-out latency, same requests. So gate the merge
on *how many gyms the account has linked*, not on a user preference — the merged affordances
appear from the second link onward.

Two consequences worth stating plainly:
- Everything above still has to be built (per-row theming, per-row gating, id disambiguation) —
  n=1 degrading to today's behaviour is a **rendering** decision, not a way to avoid the work.
- It is also the cheapest protection for the live product: if n=1 is genuinely unchanged, the
  Round 4 Psycle regression is mostly insulated from this entire workstream. Assert that with a
  test, don't assume it.

### P2 — Gym-neutral copy & design audit *(~1 day)*

The 2026-09-02 smoke test found the About pane telling a JAB user the app was "an unofficial
companion for **Psycle London**" using "**CodexFit** credentials", with auto-book firing
"(Monday 12PM)". Fixed via the new `[data-gym-name]` hook, but **that was one pane found by eye,
not an audit.**

**Do:**
1. Grep `client/index.html` and `client/src` for `Psycle`, `psycle`, `CodexFit`, `Monday`,
   `credit`, `spot`, `Barre`, `Ride` in **user-visible strings** (not identifiers or CSS classes —
   the `psycle-` class prefix and `psycleXxx` storage keys are internal and fine).
2. Route anything gym-specific through `[data-gym-name]` / `gymLabel()`, or make it neutral.
3. Onboarding (`onboarding.js`) is 6 steps of prose written for a single Psycle user and has
   **not** been reviewed for a multi-gym or JAB user at all — likely the biggest concentration.
4. The PWA manifest, `<title>`, and push-notification copy also need checking.
5. Decide the **naming vocabulary**: "class"/"spot" are already `gymLabel()`-able; confirm the set
   is sufficient for a boxing gym vs a spin studio.

### P3 — Remaining feature-parity gaps *(2–3 days)*

- **Q13 — studio-list metadata.** Two client sites decide whether a studio has a floor map by
  reading raw `metadata.studios[].layout.slots`: `timetable.js getStudioMapInfo()` and the
  Settings Manage-Maps list. **MarianaTek has no studios-list endpoint** (layout is per-class
  only), so a normalized `GET /api/studios` returning `{id, name, locationId, hasLayout}` is
  needed, with MT deriving it from upcoming classes the way `fetchStudioLayout()` already does.
- **Auto-upgrade cutoff is CodexFit-derived.** The 12h/1h logic in `poller.js` needs validating
  against MT's actual penalty boundary (see Q9 — every capture was zero-penalty).
- **Auto-upgrade should use MT's native `swap_spots`.** The adapter method exists and JAB declares
  `atomicSwap: true`; confirm the poller actually takes that path and never cancel-rebooks there.
- **Native waitlist.** JAB declares `nativeWaitlist: true` (MT auto-fills + SMS). Confirm the app
  does not duplicate or fight that.
- **Delete `/api/proxy`.** 3 callers left, all CodexFit-only and already capability-gated off for
  JAB. Its deletion is the acceptance criterion for the old layer D.
- **Auto-Book Favourites** is incomplete for *every* gym (UI saves the list, `scheduler.js` never
  consumes it) — pre-existing, not a JAB issue, but it is a parity claim in the feature table.

### Then: flip the gate *(minutes)*

1. ~~Run the acceptance test~~ — **run 2026-09-02. The server boots clean with `psycle-london`
   removed entirely** (health OK, `/api/gyms` lists only JAB, no errors in the boot log), so the
   structural goal holds. It surfaced layer I. The only `psycle-london` literals left outside the
   config/providers are in `db.js`, and they are a historical migration (`dropGymIdDefault` strips
   the WP-D2 DDL default on boot) — naming the *historical* default is correct and
   config-independent. Note `server/public/assets/*` also matches a grep for `codexfit`; those are
   stale built client bundles, not source.
2. ~~Smoke-test as a JAB user~~ — **run 2026-09-02.** Capability gating, theming, the MarianaTek
   timetable, the per-class Auto-Book countdown and the gym-scoped caches all verified in the
   browser; zero console errors. Found **3 bugs no suite could have caught** — all fixed, see
   PROGRESS.md. Gate reverted afterwards.
3. Complete J, P1, P2 and the blocking parts of P3, then re-run both tests above.
4. Set `enabled: true` on the `jab-boxing` entry in `gyms.config.js`.
5. Ideally behind a per-user allowlist first, so JAB is live for one account before everyone.

---

## User testing required before the flip

`npm test` covers none of this. Each item needs a human (or a driven browser) looking at the
running app. **Items marked 🔑 need the funded JAB account from H** and cannot be done sooner.

### Round 1 — as a JAB-only user *(partly done 2026-09-02)*

| | Check | Status |
|---|---|---|
| 1 | Timetable renders MarianaTek classes; filters populate; no empty dropdowns | ✅ done |
| 2 | No Buy Credits tab, no credit badge, no Bookmarked filter, no bookmark hearts | ✅ done |
| 3 | Navy theme applies; console clean on every tab | ✅ done |
| 4 | Auto-Book shows a **per-class** countdown, never a Monday one | ✅ done |
| 5 | Gym switch serves the right gym's data with no manual cache clearing | ✅ done |
| 6 | Floor plan / spot map opens for a JAB studio and saves a preference | ✅ done |
| 7 | Onboarding flow, start to finish, as a **new** JAB user | ⬜ |
| 8 | Settings: all four subnav sections, Manage Maps, notification prefs, calendar card | ⬜ |
| 9 | Calendar feed: enable, open the `.ics`, confirm JAB classes and correct times | ⬜ |
| 10 | Push: subscribe, fire each of the 5 notification types, check copy is gym-neutral | ⬜ |
| 11 | Mobile / installed-PWA layout as a JAB user (iOS bottom nav) | ⬜ |
| 12 | Offline banner + cached JAB data while offline | ⬜ |
| 13 | A JAB user with **no membership** is told why they cannot book | ⬜ (needs J) |

### Round 2 — live JAB booking 🔑 *(the H gate)*

| | Check | Status |
|---|---|---|
| 14 | Book a real JAB class end-to-end; confirm it appears in JAB's own app | ✅ **Passed (2026-09-02)** |
| 15 | Cancel it; confirm the membership allowance is restored | ⬜ |
| 16 | Cancel **inside** the penalty window; capture the `cancel_penalty` response | ⬜ |
| 17 | Join a waitlist; confirm MT's native auto-fill promotes it without our help | ⬜ |
| 18 | Auto-upgrade via native `swap_spots` — confirm no cancel-then-rebook occurs | ⬜ (blocked on B1) |
| 19 | Queue an auto-book for a not-yet-released JAB class and let it fire unattended | ⬜ |
| 20 | Confirm the Psycle Monday-noon dispatch still works in the same week | ⬜ |

### Round 3 — as a multi-gym user (needs P1)

| | Check |
|---|---|
| 21 | Both gyms' classes visible together in the timetable, each identifiable |
| 22 | Gym filter works, and combines correctly with location/instructor/type filters |
| 23 | Two classes with the **same provider event id** at different gyms both render and book correctly |
| 24 | Bookings / Auto-Book / Auto-Upgrade lists show both gyms without mixing them up |
| 25 | Booking from a merged view targets the **right** gym |
| 26 | Per-row capability gating: a Psycle row keeps its heart, a JAB row has none |
| 27 | One gym's API being down degrades that gym's rows only — timetable still renders |
| 28 | Auto-book queue holding entries for both gyms fires each at its own release instant |

### Round 4 — regression as a Psycle-only user

**The highest-stakes round: this is the live product.** Run it before every deploy.

| | Check |
|---|---|
| 29 | Nothing about the experience has changed for a single-gym Psycle user |
| 30 | Credit badge, Buy Credits, bookmarks, spot maps, quick-book all behave as before |
| 31 | Monday-noon auto-book fires on a real Monday with the priority tiers respected |
| 32 | Saved filters, spot maps and calendar feed survived the gym-scoping key changes |

---

## Known gaps that are NOT blockers

Recorded so they aren't rediscovered as surprises.

- **3 `/api/proxy` callers remain, all deliberately.** `credits.js` `/bundles`, `timetable.js`
  bookmarks (read + write), `settings.js` `/account/update`. All are CodexFit-only features
  already **capability-gated off** for JAB — there is no cross-gym concept to normalize.
  `/api/proxy` can be deleted once someone decides the Konami debug profile-editor isn't worth
  keeping.
- **`detectBookingWindow()` still duplicated in `client/src/lib.js`.** It mirrors
  `providers/codexfit.js resolveBookingWindow()`. Off the correctness path (the server stamps
  `releaseAt` on every event), but it is Psycle policy living in shared client code.
- **`getClassReleaseTime()` keeps a legacy Monday-noon fallback** for events cached before the
  server began stamping `releaseAt`. Remove once the client cache has rolled over.
- **MarianaTek's derived metadata describes the timetable, not the gym.** `fetchMetadata` builds
  locations/studios/instructors/class-types from upcoming classes because MT has no endpoints for
  them. An instructor with no upcoming classes won't appear as a filter option.
- **The advanced-booking-credit floor is gone.** Psycle no longer issues those credits
  (stakeholder, 2026-09-01). If a gym ever needs a rule like it, it belongs in **that gym's
  adapter** (`codexfit.js resolveBookingWindow`), never back in the shared evaluator.
- **Client cache keys are all gym-scoped now, but only `cache.js`'s own are unit-tested.**
  Gym-scoped: the `api-responses` prefix (`userId@gymId`), `psycleCacheEvents`/`psycleCacheMeta`
  in the sibling `cache` store, `psycleCacheTime`, `psycleActiveStudioIds{,Time}`, and
  `psycleDefaultFilters` — all via `gymScopedKey()` in `cache.js`, called at **use** time so the
  key follows the active gym. There is deliberately **no fallback** from a gym-qualified key to
  the bare one: that would hand a gym with no saved data the *previous* gym's provider ids, which
  is the bug. Cost: anyone who has explicitly picked a gym re-saves their filters once.
  `timetable.js`/`settings.js` usage is covered only by the browser smoke test — importing
  `timetable.js` into vitest pulls in most of the app.
- **The MarianaTek mock releases every class in the past.** `mock-marianatek.js` sets
  `booking_start_datetime` behind "now" for all classes, so no per-class countdown or future
  release is exercisable in dev without synthesising a `releaseAt`. Harmless, but it is the same
  kind of over-generous mock that hid the WP-C1 relations bug — worth emitting a past/future mix.
- **`cancel_penalty` on MarianaTek is unmapped for the penalty case.** Every captured response
  had `is_penalty_cancel: false`. The poller's 12h/1h cutoff logic is CodexFit-derived and needs
  validating against MT's actual boundary — see `Documentation/Services/marianatek.md`.

---

## Traps that have bitten more than once

Read this before touching client code.

1. **Normalized ids are STRINGS; raw provider fields are numbers.**
   `metadata.studios.find(s => s.id === e.studio_id)` is *silently false*, not an error. Use
   `sameId()` / `String()`. This shipped three times: caught once by tests, twice only by a
   browser smoke test (an empty location dropdown, then an empty studio list).

2. **Capability-gating markup means guarding its event wiring too.** Gating the bookmark heart's
   HTML without guarding `row.querySelector('.psycle-timetable-heart').onclick` threw on every
   row and emptied the **entire** timetable for JAB. Gate both, or neither.

3. **`[hidden]` loses to an inline `display`.** Several elements in `index.html` carry one, so a
   gated feature stayed fully visible. `styles.css` has `[hidden] { display: none !important; }`
   — don't remove it.

4. **`undefined` capability flags must default to ON.** Hiding a feature a gym *has* is permanent
   and silent; briefly showing one it hasn't self-corrects when the catalogue loads.

5. **A stale `sweatActiveGymId` in localStorage 403s every request.** `api.js` now clears it when
   the server says "not linked to gym", but if you see blanket 403s in dev, check that key first.

6. **Restarting the dev server mid-test produces fake failures.** Poll `/api/health` before
   navigating; several "regressions" this session were the page loading before the server
   answered.

7. **"Resolves per gym" is not the same as "runs per gym."** WP-D8 made every booking resolve its
   own release instant, and layer E was marked closed — but the **orchestrator** that decides when
   to wake was still hardcoded to Psycle's Monday noon, so a per-class gym's entry was never armed
   *and* was then filtered out for not matching. Two compounding failures, and every dispatch test
   entered below them via `runAllPendingBookings()`. When you convert a policy, check what
   *schedules* the policy, not just what evaluates it. `server/test-wake-clock.js` now pins the
   armed instant for a mixed queue.

8. **`api-responses` is not the only client cache.** `timetable.js` keeps raw events and metadata
   in the sibling `cache` store under its OWN key names, and there are TTL stamps and derived
   studio ids in localStorage. Gym-keying only the API-response store left a JAB user staring at
   Psycle's timetable while every network call correctly returned MarianaTek data — clean console,
   no error. Use `gymScopedKey()` from `cache.js`, and call it at **use** time, not module load.

9. **A "consolidated" helper is not consolidated until the last inline copy is gone.**
   `credit-allowance.js` handled the unmetered case correctly while four call sites still did
   their own `available_credits.reduce()` and so never consulted `isMetered()` — every JAB card
   read "⚠ Insufficient Credits". After extracting a helper, grep for the pattern you extracted.

10. **Copy is a capability surface.** The About pane hard-coded "Psycle London", "CodexFit" and
    "(Monday 12PM)" in prose a JAB user reads. It fails silently — nothing throws, the layout is
    fine, the words are just false. Use the `[data-gym-name]` hook.

11. **Any process-local Map/Set keyed on a provider id is a cross-gym collision.** `gym_id` on
   every table made the *database* safe and hid the fact that `scheduler.js` coordinated through
   in-memory Sets keyed `eventId:slotId`. Two gyms can both publish event 12345 slot 7. The
   `eventCache` case was the worse one — a hit served one gym's floor plan as another's, so the
   scheduler booked against slots that don't exist in the room. Neither could ever fail a SQL
   test, which is why both survived six work packages. **Put `gymId` in the key; don't clear
   state on transitions.** Clearing is a correctness guarantee resting on a habit.

---

## Verifying this file

```bash
npm test                                    # 16 server suites + 44 client tests

# spot-check the eight closed layers
grep -n "getProvider(" server/*.js | grep -v test-      # no module-level consts (B)
grep -n "DEFAULT 'psycle-london'" server/db.js          # no DDL defaults (A)
grep -c releaseAt server/scheduler.js client/src/lib.js # releaseAt consumed (E)
grep -c "data-requires-capability" client/index.html    # UI gated (F)
grep -cE "\.(start_at|event_type|studio_id)\b" client/src/ui/timetable.js   # → 0 (D)
grep -n "claimKey = \|eventCacheKey" server/scheduler.js  # gymId in both (G)
grep -n "activeGymSegment" client/src/cache.js            # gym in cache key (G)
grep -n "getNextReleaseInstant" server/scheduler.js        # queue drives the clock (I)
grep -c "getNextMondayNoonLondon" server/scheduler.js     # → 0 (I)

# what's left
grep -n "enabled" server/gyms.config.js                 # the gate itself
```

### Smoke-testing as a JAB user

The only way to catch the traps above. `npm test` cannot.

```bash
npm run dev
# wait for /api/health to answer before loading the page
```

**Fastest path — `node server/dev-setup-jab.js`** does steps 1, 3 and 4 for you (polls
`/api/health` first, refuses with a clear message if the gate is still closed, prints the
`localStorage` lines to paste). `--gym psycle-london` switches back. Manual equivalent:

1. Log in as `dev@psycle.com` (any password).
2. **Temporarily** set `enabled: true` on `jab-boxing` in `gyms.config.js`, restart the server.
3. `POST /api/my-gyms/link` `{ gymId: 'jab-boxing', email: 'dev@jabboxing.mock', password: 'x' }`
4. `POST /api/my-gyms/active` `{ gymId: 'jab-boxing' }`, set `localStorage.sweatActiveGymId`,
   reload.
5. Expect: MarianaTek classes render; no Buy Credits tab, no credit badge, no Bookmarked filter;
   navy accent.
6. **Revert the `enabled` flag.** It is the rollout gate.

See [TESTING.md](../../TESTING.md) for the three testing layers and what each can and cannot
catch.
