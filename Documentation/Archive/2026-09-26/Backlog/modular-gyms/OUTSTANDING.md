# Multi-gym app — current handoff and build order

**Start here.** This is the current source of truth for what remains in the modular app.

- Historical 2026-09-02 handoff → [ARCHIVE-2026-09-02.md](./ARCHIVE-2026-09-02.md)
- Per-work-package history → [PROGRESS.md](./PROGRESS.md)
- Original audit and rationale → [FINDINGS.md](./FINDINGS.md)
- Original implementation plan → [PLAN.md](./PLAN.md)
- Live acceptance procedure → [LIVE_VERIFICATION_PLAYBOOK.md](./LIVE_VERIFICATION_PLAYBOOK.md)

Last reconciled **2026-09-14** against the current worktree. Status below deliberately separates
code present, mechanical verification, and live acceptance.

---

## Target architecture

Every gym is an equal upstream service:

| Layer | Owns |
|---|---|
| Platform adapter (`providers/*.js`) | Authentication and provider protocol |
| Gym entry (`gyms.config.js`) | Instance URLs, policy, theme and capabilities |
| App (everything above `providers/`) | Normalized data and capability-driven behaviour |

Acceptance criterion: adding a third gym requires changes only in `providers/` and
`gyms.config.js`. The single-gym path must retain its existing behaviour and avoid multi-gym
fan-out.

---

## Current state

### Implemented in the current worktree

- Per-gym account identity, session renewal and gym-scoped persistence.
- Gym-qualified runtime state and cache keys.
- Provider-neutral normalized client data.
- Per-gym booking-window policy and queue-driven Auto-Book wake clock.
- MarianaTek timetable pagination.
- MarianaTek live booking plus atomic spot-swap support in the adapter/poller paths.
- Account eligibility separate from credit arithmetic.
- Sequential first-run linking of more than one gym.
- Merged timetable, bookings and waitlists for multi-gym accounts, while retaining the n=1 path.
- Gym badges/filtering, per-row capability gating, per-row action routing and gym-qualified
  metadata lookups.
- Multi-gym credit badges and per-gym studio-preference reads/writes.
- Initial gym-neutral copy audit and JAB/Psycle visual differentiation.
- Per-gym Credits & Membership surfaces and normalized membership/eligibility data.
- Account / Your Gyms / About settings, with one explicit-gym renderer used inline or in a drawer.
- Account-scoped unified timetable caching, measured warm-cache improvements and structured
  loading skeletons.

### Mechanically verified on 2026-09-14

- Server: **16/16 suites pass** under Node.js 20.19.0.
- Client: **60/60 Vitest tests pass**.
- Production client build completes. Vite reports the existing mixed static/dynamic-import chunking
  warnings; they do not fail the build.

### Live acceptance still open

The worktree contains substantial uncommitted multi-gym changes. Do not infer production readiness
from the source or client tests. The live acceptance matrix below remains the release gate.

### Next agent action

**Status as of 2026-09-15.** 17/17 server suites and 64/64 client tests pass under Node.js
20.19.0; the production client build completes. Much of the multi-gym build is now
**live-verified against real Psycle + JAB data** on `sweat-dev.wingfield.tech`, not just
source-verified — see "What is verified live" below for exactly which parts, because the
distinction still matters.

Read these two first:
- [../timetable-and-credits.md](../timetable-and-credits.md) — live-review findings, the
  timetable information-hierarchy proposal, and the ranked TODO. **T1 and T2 are now
  FIXED**; T3–T7 remain.
- [../ui-ux-sweep.md](../ui-ux-sweep.md) — UI/accessibility backlog. §A1/A2 are done
  (toasts now announce and escape). **§A5 (570 `!important`) must NOT be started until
  live acceptance is complete** — it touches every screen.

Then: the remaining step 6 items, and the live acceptance matrix, which is still the
release gate.

### What is verified live (2026-09-15)

Against a real two-gym account on staging, with real Psycle and JAB data:

- Merged timetable renders both gyms, each row reading and writing through its own gym.
- Per-class credit requirements normalize end to end (a >1-credit class survives).
- First-come-first-serve classes resolve to "Quick Book" with no seat map.
- "Buy Credits" appears on `psycle-london` rows only, never JAB.
- Calendar feed: ONE `.ics`, four VEVENTs, `Psycle:` and `JAB:` entries side by side.
- Settings → Your Gyms lists both gyms with per-gym sub-sections; no switcher anywhere.
- Schedule cache: 6,105ms cold → 0ms warm on 2,482 live Psycle events.

Still NOT verified live: push notifications, the calendar feed on a real device, the
installed PWA layout, offline behaviour, and an unattended Auto-Book firing. Those are the
matrix items below.

### Hard-won layout rules (2026-09-15)

Recorded because each cost several failed attempts and all of them look correct until
measured:

1. **`min-width` on a `<td>` is not honoured under `table-layout: auto`.** Columns are
   sized from content. Three separate floors were added to `td.col-actions` and every one
   was silently ignored (the cell measured 1px while Status took 388px).
2. **`width: 1px` shrink-to-fit lets content OVERFLOW rather than expanding the cell.**
   The action group then spilled left across Status — the overlap that kept "coming back".
3. **An explicit px width is the only thing auto layout reliably honours.** Status is
   112px for that reason.
4. **`!important` beats specificity.** A `display: none` without it lost to the generic
   `.psycle-table td { display: table-cell !important }`, so the merged column rendered
   at desktop width alongside the columns it replaces. Any new rule targeting a table cell
   needs `!important` in this stylesheet.
5. **Source order decides between equal-specificity rules.** The Settings submenu indent
   sat at line 5222 and the base menu-item rule at 8356 — same specificity, so the indent
   did nothing until it was moved after and chained both classes.
6. **Measure the right thing.** The occupancy overlap was reported fixed twice while still
   broken, because the metric compared CELL edges — and the pill overflows its cell. The
   correct metric is pill-right vs button-left.

### Worktree handoff

- The modular build is intentionally **uncommitted** and overlaps many tracked files. Preserve the
  existing worktree; do not reset or check out files to recover a clean baseline.
- Important new files include `.nvmrc`, `ui/gym-settings-section.js` and its test,
  `ui/loading-skeleton.js` and its test, the Settings/Credits specs, and the archived 2026-09-02
  handoff.
- Use Node.js 20.19.0 from `.nvmrc`. The most recent local checks are recorded above; rerun them
  before making a new completion claim.
- No deployment was performed. Temporary localhost services were stopped, and the mock JAB link
  created for the two-gym Settings smoke was removed from `dev@psycle.com` afterward.

---

## Build and verification order

### 0 — Restore a trustworthy test environment *(done 2026-09-12)*

Node 20.19.0 was selected, `better-sqlite3` rebuilt, `npm test` passed (16/16 server suites and
60/60 client tests), and `npm run build:client` completed.

### 1 — Live acceptance gate *(still open; can run alongside the remaining build)*

Run the multi-gym and Psycle-only browser checks before deployment. Highest-risk cases:

- A merged timetable row always reads and writes through its own `gymId`.
- Colliding provider event, studio, instructor and slot ids remain isolated.
- Bookings, waitlists, Auto-Book and Auto-Upgrade contain both gyms without mixing data.
- Per-row capability gating remains correct.
- One provider failing degrades only that gym's data.
- A single-gym Psycle account sees no new multi-gym controls or fan-out regressions.

Also complete the remaining live MarianaTek write checks: cancellation outside/inside the penalty
window, native waitlist behaviour, atomic swap verification, and an unattended future Auto-Book.

### 2 — Credits & Membership *(implemented 2026-09-12; browser acceptance open)*

Build the shared membership surface described in
[../multi-gym-buy-credits.md](../multi-gym-buy-credits.md):

Implemented: normalized membership data and `/api/membership`; MarianaTek membership mapping;
per-gym Credits & Membership sections; public `websiteUrl` gym metadata; config-driven checkout
fallback; and explicit `gymId` routing for checkout. A purchase-gym dropdown remains deliberately
deferred until a second linked gym supports purchases.

Avoid fetching the same MarianaTek membership payload separately for eligibility and display; use
one provider result or a bounded shared cache.

### 3b — Settings restructure, round 2 *(implemented 2026-09-14)*

Feedback after the first two-gym browser session drove a second pass:

- ✅ **Five sections: General / Notifications / Account / Your Gyms / About.** The previous single
  "Account" pane held eight unrelated cards.
- ✅ **The calendar feed moved to ACCOUNT level.** It was rendered per gym, so a two-gym member got
  two `.ics` URLs each covering part of their week. One feed now carries every linked gym — see the
  AGENTS.md entry for the three traps in the move (per-gym sessions, `gymId:eventId` keys, per-gym
  reconciliation). Verified end to end in a browser: one URL, four VEVENTs, `Psycle: Ride with
  Adam` and `JAB: Boxing with George` side by side.
- ✅ **JAB is enabled automatically in dev**, and the dev login seeds every enabled gym onto
  `dev@psycle.com`. The rollout gate being off was indistinguishable from the multi-gym build being
  broken: with no second gym in the catalogue nothing was "addable", so the Your Gyms card hid
  itself and a single-gym account had no path to link a second gym at all.
- ✅ **Mocks expanded to realistic timetables** — Psycle 148 classes over 14 days across 4
  locations, 9 studios, 10 instructors and every discipline group; JAB 8 classes a weekday across 6
  class types and 5 instructors. Deterministic occupancy (some full with waitlist, some nearly
  empty) that does not reshuffle on reload. A two-class-per-day mock cannot surface a filter,
  discipline-pill, waitlist-state or merged-ordering bug.

### 3 — Settings restructure *(implemented 2026-09-12; live relogin acceptance open)*

Implement [../settings-restructure.md](../settings-restructure.md) in its documented phases:

1. ✅ Auto-Upgrade settings are consistently gym-scoped; an idempotent migration backfills every
   existing linked gym while preserving gym overrides.
2. ✅ One explicit-`gymId` gym-section renderer now owns connection, membership/credits,
   booking window, Auto-Upgrade, spot maps, calendar and Profile Explorer. It is mounted inline in
   the existing four-pane UI and covered by client component tests. Browser acceptance is open.
3. ✅ Restructured to Account / Your Gyms / About. The shared renderer is inline for n=1 and in a
   drawer/full-screen mobile surface for n>=2. Both shapes passed a local mock browser smoke.
4. ✅ Added per-gym drawer accenting, responsive mobile treatment, empty states and an actionable
   re-authentication warning. The JAB drawer passed local mock visual QA; a real expired-session
   warning still needs live acceptance.

The scope migration is the only data-sensitive phase and must be verified independently.

### 4 — Timetable performance and loading UX

1. ✅ Instrumented a local warm-cache refresh: IndexedDB took 1.3 ms and metadata-map rebuilding
   0.2 ms. The dominant avoidable work was 23.1 ms of row-render prerequisites plus 14.3 ms waiting
   for metadata before the cache read.
2. ✅ Cached rows now use in-memory action state while metadata, bookings, waitlists, Auto-Book and
   studio preferences refresh in parallel. The comparable cached render fell from 29.7 ms to 3.4 ms,
   with prerequisite time reduced to 0 ms. Unified timetable data is account-scoped.
3. ✅ Shared accessible row/card skeletons cover timetable, bookings, waitlists, Auto-Book and
   Auto-Upgrade cold loads, with mobile and reduced-motion treatment.
4. The Phase 3 user-agnostic schedule cache is deferred: the client warm-cache path is now proven
   fast, so a server cache would address cold provider latency rather than this regression.

### 5 — Visual-system cleanup

- ✅ Psycle's identity colour is violet `#7c3aed` (decided 2026-09-14), matching its existing
  `gyms.config.js` theme entry. Both gyms' brands now resolve from per-gym CSS tokens
  (`--gym-<id>-ink` / `-ink-hover` / `-tint` / `-on`) defined for *every* gym at `:root` and
  restated per theme. All previously hardcoded per-gym hexes (`#B2503A`, `#E07A5F`, `#6366f1`,
  `#4338ca`, `#5D71C9`, `#18214D`) are gone from `styles.css`.
  - **`--accent` belongs to Sweat Assistant and is never a gym's colour.** A first attempt mapped
    the active gym's brand onto `--accent`, repainting the whole app per gym. That is wrong for
    what this product is: the goal is both gyms' classes in ONE environment, and if the entire
    chrome is violet then violet stops telling you a row is Psycle's. A gym's colour appears only
    on elements that identify that gym — chip, card rail, row tint, settings card, header badge.
    Reverted the same day; the rule is stated at the top of the per-gym theming section in
    `styles.css`.
  - Fixed while doing this: the Psycle gym chip resolved from `var(--accent)`, so in a merged
    multi-gym view a Psycle chip painted in JAB's colour whenever JAB was the active gym. Per-gym
    colours must never read `--accent` — that is the *active* gym's colour only.
- ✅ Increased the shared timetable gym-chip text from 10 px to 11 px without changing its fixed
  alignment width.
- ✅ Consolidated card typography. The Auto-Upgrade card was a hand-inlined single-line row while
  Bookings, Waitlists and Auto-Book used the shared `.ab-card-*` system; it now uses the same gym
  rail, date/time pairing, discipline tag, serif class title, instructor line and footer.
  - Fixed while doing this: Auto-Upgrade cards set `className = 'psycle-autobook-card'` without
    `ab-card`, so every per-gym tint rule (`.psycle-autobook-card.ab-card[data-gym=...]`) silently
    never matched them.
  - Fixed while doing this: `.ab-card-instructor` set `color: var(--text-md)` — a *size* token in a
    colour slot, so instructor names fell back to inherited colour.
  - Fixed while doing this: a Bookings label at 11 px, below the documented 12 px `--text-xs` floor.
- ✅ Instructor thumbnails: yes, lazy-loaded (decided 2026-09-14). `NormalizedInstructor` gained
  `thumbUrl`, distinct from `imageUrl`, so MarianaTek's `thumbnail_url` is used for the 26 px card
  avatar and `large_url` stays for the hover tooltip. CodexFit publishes one size only and falls
  back to it. `tooltips.js instructorAvatar(name, gymId)` resolves by name (all Auto-Book and
  Auto-Upgrade rows carry) and is gym-scoped, since two gyms can share an instructor name as easily
  as an id. Renders `loading="lazy" decoding="async"` in a fixed 26 px box so a missing or slow
  image never reflows the row.
- ✅ The timetable gym pill now carries the gym's logo alongside its text label. Text is kept
  deliberately: colour and glyph alone fail in forced-colours mode and for colour-blind users, and
  in a merged list the pill is what identifies a row's gym.
- ✅ **Action-column colours consolidated to two weights.** Every `.primary` segment used to carry
  its own solid hue (accent for Quick Book, lilac for Auto-Book, dark blue for waitlist, another
  for Buy Credits) and secondaries were tinted with their own semantic hue on top. Down a
  single-gym list of near-identical rows that read as colour-coding; in a merged timetable, where
  consecutive rows are in different states AND carry different gym tints, it read as a patchwork.
  Now: one filled primary per row in the app accent, one quiet neutral treatment for secondaries,
  and semantic hue kept only for destructive actions.
- ✅ **Spot-map labels fixed.** "Bike 27" wrapped to two lines in a ~30 px square, and the priority
  badge REPLACED the label — so the map showed "1, 2" while the caption said "Bike 27, Bike 28" and
  the two could not be correlated. Labels now shrink to "27" (shared word stripped only when every
  label shares it) with the order in a corner badge; full label in the tooltip.
- Add official gym logos only where they improve scanning rather than duplicating existing badges.

### 6 — Remaining parity and technical cleanup

- ✅ **`/api/proxy` is removed** (2026-09-14) — the stated acceptance criterion for layer D. Its
  last three callers became capability-gated normalized routes: `GET /api/bundles`,
  `PUT|DELETE /api/bookmarks/:identifier` and `POST /api/profile/update`, backed by new
  `listBundles` / `setBookmark` / `updateProfile` methods on the provider contract. Each rejects on
  the *gym's* capability flag (501 `CAPABILITY_UNSUPPORTED`) before reaching an adapter. No client
  code can name a provider's own URL any more. `proxyRequest()` survives as an internal server
  helper for the CodexFit cart flow, which is a different thing from exposing it to the client.
  `test-regression-psycle.js` now asserts `/api/proxy/*` returns 404 and that its replacements work.
  - Fixed while doing this: `db.touchUserLastSeen` was stamped **only** inside the proxy handler,
    so it was CodexFit-only by accident — a MarianaTek account never touched the proxy and its
    `last_seen_at` never moved, making every JAB user look dormant in the admin panel. As the
    client migrated off the proxy the same staleness had started reaching Psycle accounts. Now in
    `auth.js authenticateToken`, the one chokepoint every authenticated request passes, throttled
    in SQL to one write per 5 minutes.
  - Fixed while doing this: the debounced calendar refresh on booking/waitlist mutations also lived
    only on the proxy, so an in-app booking through `/api/book` did not reach the `.ics` feed until
    the 3-hourly cron — and for JAB it never did at all. Now on the normalized write routes
    (`/book`, `/cancel`, `/waitlist/join`, `/waitlist/leave`, `/swap`).
  - Noted, not fixed: the rest of the normalized surface has **no rate limiting**. The three new
    routes carry the proxy's old 60/min-per-user budget; the other ~25 do not. A blanket limiter
    would break legitimate bursts such as an 8-week prefetch, so it needs its own measured budget.
    Logged in [../ui-ux-sweep.md](../ui-ux-sweep.md) §D1.
- Add normalized studio-list metadata for providers without a studio catalogue endpoint.
- Validate the Auto-Upgrade cutoff against MarianaTek's real penalty boundary.
- Verify native waitlist auto-fill does not conflict with app behaviour.
- Complete Auto-Book Favourites; the UI stores them but the scheduler does not consume them.
- Verify multi-gym push notifications and calendar feeds end to end.

### 7 — Later product work

- Guest-pass booking on MarianaTek.
- User-agnostic schedule cache plus short-lived occupancy cache.
- Self-service account recovery.
- Operational observability, backups and distress-abort handling.

---

## Live acceptance matrix

### JAB-only account

- [x] Timetable and filters render MarianaTek data.
- [x] Unsupported purchase/bookmark controls are hidden.
- [x] Per-class Auto-Book countdown is shown.
- [x] Gym switching changes data without manual cache clearing.
- [x] Floor plan opens and a spot preference can be saved.
- [ ] Complete onboarding from a fresh account.
- [ ] Exercise every Settings section.
- [ ] Enable and inspect the JAB calendar feed.
- [ ] Exercise all five push notification types and confirm gym-neutral copy.
- [ ] Verify installed/mobile PWA layout.
- [ ] Verify cached JAB data while offline.
- [ ] Confirm a no-membership account receives the eligibility explanation.

### Live MarianaTek writes

- [x] Book a real class and confirm it in JAB's own app.
- [x] Cancel outside the penalty window and confirm allowance restoration.
- [ ] Cancel inside the penalty window and capture the provider response.
- [x] Join and leave a live waitlist.
- [ ] Confirm native waitlist auto-fill promotion behaviour.
- [x] Exercise MarianaTek's native `swap_spots` endpoint live.
- [ ] Confirm Auto-Upgrade uses native atomic swap, never cancel/rebook.
- [ ] Allow a future JAB Auto-Book to fire unattended.

### True multi-gym account

- [ ] Verify both gyms together in every list view.
- [ ] Verify gym filter combinations.
- [ ] Exercise deliberately colliding provider ids across gyms.
- [ ] Book/edit/cancel from a row whose gym is not the persisted active gym.
- [ ] Verify per-row capability gating.
- [ ] Verify one-provider failure degrades cleanly.
- [ ] Let queues for both gyms fire at their own release instants.

### Psycle-only regression

- [ ] Confirm the n=1 UI and request pattern remain unchanged.
- [ ] Verify credits, purchases, bookmarks, maps and Quick Book.
- [ ] Verify a real Monday release with priority tiers.
- [ ] Verify filters, maps and calendar data survived key migrations.

---

## Non-blocking known limitations

- MarianaTek metadata is derived from upcoming classes; unscheduled entities cannot appear in
  filters.
- The MarianaTek mock currently releases every class in the past, so it cannot exercise a future
  per-class countdown without a synthetic fixture.
- The remaining `/api/proxy` callers are CodexFit-only and capability-gated, but retain deprecated
  platform coupling until normalized.
- Low-impact filter labels can still be ambiguous when two gyms expose identically named metadata;
  the underlying selection/action data must remain gym-qualified.

---

## Rules that prevent repeat regressions

1. Provider ids are strings and are unique only inside one gym.
2. Every per-row read/write/action must carry `gymId`; never rely on the active gym in a merged
   view.
3. Every shared Map, Set, cache or DOM data key built from provider ids must include `gymId`.
4. List reads may fan out; write paths target exactly one gym.
5. Per-gym failures degrade merged reads rather than blanking the whole view.
6. Capability checks in list contexts are per row, not global.
7. Missing release time means skip; never substitute “now”.
8. Gym policy belongs in `gyms.config.js`, not a shared platform adapter or client helper.
9. A single-gym account follows the original n=1 path.
10. Source/tests, deployment, live behaviour and stakeholder acceptance are separate states.
