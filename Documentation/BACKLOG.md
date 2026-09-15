# Sweat Assistant — Project Backlog

This document tracks **open** feature requests, bugs, technical debt, and future architectural tasks.

Finished work is archived in [Backlog/COMPLETED.md](file:///Users/pierswingfield/Desktop/AI%20Projects/psycle%20chrome/App/Documentation/Backlog/COMPLETED.md) — this file is loaded into agent context every session, so it is kept short on purpose. Move items there when they are done rather than growing a completed section here.

For the modular app, [Backlog/modular-gyms/OUTSTANDING.md](file:///Users/pierswingfield/Desktop/AI%20Projects/psycle%20chrome/App/Documentation/Backlog/modular-gyms/OUTSTANDING.md) is authoritative for current state, next build action and live acceptance. Historical `✅` sections below explain earlier fixes and are not actionable.

---

## Timetable, credits correctness & caching (raised 2026-09-14, partly done)

See [Backlog/timetable-and-credits.md](Backlog/timetable-and-credits.md).

- ✅ **T1 credit correctness** — per-class cost and accepted credit types now come from the
  provider, not from arithmetic on a balance. Guest-only credits excluded.
- ✅ **T2 timetable speed** — shared server-side schedule cache (6,105ms cold → 0ms warm on
  2,482 live events), stale-while-revalidate with single-flight.
- ✅ **T4 filters grouped by gym** (2026-09-15) — location/instructor dropdowns group by gym
  + disambiguate collisions; class-type dropdown groups AND buckets to coarse categories
  (Boxing/Train/Recovery/PT/Workshop…) via the same classifier the discipline pill uses.
  Also fixed the reason JAB's class types needed bucketing in the first place: `discipline`
  was reading MarianaTek's room name instead of the real class type.
- Open: T3 instructor photo caching/resizing, T5 toast redesign, T6 refresh painting from
  cache instead of blocking, T7 smaller items.

## Naming audit + spot-map editor (raised 2026-09-15)

See [Backlog/naming-and-spotmap.md](Backlog/naming-and-spotmap.md).

- **`psycle-` prefix audit.** 670 uses of `#psycle-helper-container` in `styles.css` plus
  ~370 distinct `psycle-*` class tokens, for an app that is now Sweat Assistant serving
  several gyms. Mostly mechanical, but the storage keys are persisted user data (renaming
  `psycleLocalToken` logs everyone out) and the id carries specificity that 570
  `!important`s lean on. Not a find-and-replace; do not start during a feature push.
- **Spot-map editor**: whole-row `+` buttons are meaningless in some studios and should be
  gated on something real rather than "more than one row"; rows need a minimum vertical
  gap, with the map scrolling inside its own container rather than pushing Save off-screen.

## 0. Open Items Raised 2026-09-02 (session 5)

### Psycle Brand Colour Inconsistency (Design)
* **Status**: ❌ Open — real, confirmed
* **Summary**: Psycle's identity colour is muddled across the app because it inherited the app's own default palette from before JAB existed, and was never given a real distinct token. Confirmed **four different "Psycle" colours** currently in play, none of them consistently applied: the global default `--accent` (`#d2876b` light / `#c9785c` dark, `styles.css:40,141,207`) used everywhere as the generic CTA colour; `#B2503A` used in the gym-tint/rail component rules (row tinting, Auto-Book card rails); `#E07A5F` used as that same tint's dark-mode variant; and `gyms.config.js`'s own declared `theme: { primary: '#7c3aed' }` (violet) for Psycle — which, confirmed by grep, **is never actually read by any CSS rule**. There is no `:root[data-gym="psycle-london"]` token-override block at all (JAB has none either — its navy is hardcoded per-component, not sourced from its own `theme.primary: '#18214D'`, coincidentally the same number). **Needs a stakeholder decision**: pick ONE real Psycle brand colour (candidates: keep `--accent` as-is and make JAB the only gym with a distinct identity; or adopt the unused `#7c3aed` violet from config; or formalize `#B2503A`/`#E07A5F` as the real token and update `--accent` to match it) — then wire it through an actual `:root[data-gym="psycle-london"]` override block so `gyms.config.js`'s `theme.primary` becomes the real source of truth for both gyms, not just documentation nobody reads.

### Instructor Thumbnail in Timetable Rows (Feature)
* **Status**: ❌ Open
* **Summary**: Show a small instructor photo thumbnail inline in the timetable's Instructor column, not just on hover-tooltip. Now feasible — `NormalizedInstructor.imageUrl` is correctly populated for both gyms as of the 2026-09-02 photo-mapping fix (`codexfit.js`'s `photo` field, `marianatek.js`'s `photo_urls`). **Needs its own design pass**: raw CodexFit photos are full-size S3 originals (unknown dimensions, no resize params observed in the URL) — decide whether to cache+resize server-side (a real image-processing addition, new dependency) or rely on `<img>` + CSS `object-fit: cover` at a small fixed size (simpler, still downloads the full image over the wire per row, more bytes than ideal for a timetable with 800+ rows).

### Reformer (and possibly other) Studios Show Quick-Book-Only Despite Having a Spot Map (Bug)
* **Status**: ✅ Fixed 2026-09-02
* **Root cause confirmed**: `mergeMetadataFromEvents()`'s fallback studio-stub (`timetable.js:167`) — used when an event references a `studioId` not present in the initial `/api/metadata` fetch — creates `{ id, name, locationId }` only, with no `hasLayout`/`gymId`. `event.studio` (the other candidate source considered) turned out to be **never populated by either adapter** — a dead fallback, not usable. `layoutFormat` (the other field considered) also isn't the right signal: CodexFit hardcodes it to `'pick-a-spot'` for every event regardless of whether real floor-plan data exists, so it answers "is this conceptually a spot-picking class" not "do we have the layout to render."
* **Fixed**: new `resolveHasMap(studio)` helper in `timetable.js` — an *explicit* `hasLayout: false`/`true` from real `/api/metadata` (both adapters always emit a real boolean there, confirmed) is honored as-is; a bare stub with no `hasLayout` key at all now defaults to `true` (optimistic) rather than `false`. Same principle already used for capability flags: showing Book/config for a studio that turns out to have no floor plan self-corrects (the modal's own "No floor map available" empty state handles it); hiding one that DOES have a map was a silent, permanent dead end.

### Quick-Book Visual Weight When No Spot Preferences Exist (Design)
* **Status**: ✅ Fixed 2026-09-02
* **Fixed**: `buildActionModel()`'s "seat map but no saved prefs" branch (`timetable.js`) now assigns `variant: 'success-outline'` instead of `'success'`. New CSS rule (`styles.css`, alongside the other segment variants) — transparent background, `--success`-coloured border and text — visually distinct from both the solid `success` fill (used once preferences exist) and the light-tint `success-muted` used for the "Book" secondary.

---

## 1. Resolved Immediate Fixes (Phase 1 & Hotfixes Completed 2026-09-02)

### Auto-Upgrade for MarianaTek & Unmetered Gyms (Bug B4)
* **Status**: ✅ Completed (2026-09-02)
* **Resolved**: Poller now queries provider adapter `fetchEventDetails()`, checks `gym.capabilities.metered`/`atomicSwap` before credit checks, preserves string spot IDs, and successfully executes atomic spot swaps via `POST /me/reservations/:id/swap_spots`. Tested end-to-end with regression test `server/test-poller-upgrade.js`.

### Edit Bookings Modal & Atomic Spot Swapping (Bug B9)
* **Status**: ✅ Completed (2026-09-02)
* **Resolved**: Fixed `saveEdit is not defined` reference error in `bookings.js`, resolved string slot IDs across `slotToBooking` and layout slots, and integrated atomic spot swaps via `api.swapSpot()` when `atomicSwap: true`.

### Multi-Spot Booking & Per-Gym Booking Limit (Bug B10)
* **Status**: ✅ Completed (2026-09-02)
* **Resolved**: Added `maxSpotsPerClass` capability to `gyms.config.js` (`1` for JAB, `null` for Psycle). `timetable.js` enforces single-spot selection replacement when limit is 1, and fixed toast handling so partial declines no longer display contradictory success toasts.

### Timetable Instructor Filter Completeness (Bug B11)
* **Status**: ✅ Completed (2026-09-02)
* **Resolved**: Added `mergeMetadataFromEvents()` in `timetable.js` to dynamically harvest all instructors appearing across the 4-week timetable window, ensuring the filter dropdown lists all instructors scheduled. Expanded default `fetchMetadata()` query in `marianatek.js` to 28 days.

### Occupancy Tooltip & Minimap for Recovery / FCFS Classes (Bug B5)
* **Status**: ✅ Completed (2026-09-02)
* **Resolved**: `tooltips.js` calculates capacity and open counts cleanly for normalized and legacy payloads. If `layoutSlots.length === 0` (e.g. recovery / FCFS), it renders a clean capacity card (Total, Open, Booked) without an empty floor map box or legend.

### Recovery Classes Timetable Placeholder Labels (Bug B6)
* **Status**: ✅ Completed (2026-09-02)
* **Resolved**: `timetable.js` desktop table rows and mobile cards now omit empty instructor and studio labels instead of rendering `"Instructor"` and `"Studio"`.

### Instructor Photos & Rich Bios Mapping (Bug B7)
* **Status**: ✅ Completed (2026-09-02)
* **Resolved**: `marianatek.js` maps `photo_urls` to `imageUrl`, `bio`, `instagramUrl`, `instagramHandle`, and `spotifyUrl`. `tooltips.js` consumes these normalized properties to display rich bios, photos, and social links.

### Onboarding Trigger on Upgrade & Gym Name Display (Bug B8)
* **Status**: ✅ Completed (2026-09-02)
* **Resolved**: `shouldShowOnboarding()` skips onboarding if the user is already authenticated with linked gyms. `stepGyms` resolves gym names correctly across `allGyms` and `myGyms`.

---

## 2. Remaining multi-gym product and acceptance work

### Ground-Up UX Assessment & Theming Overhaul (UX1)
* **Status**: ❌ Open (Phase 2)
* **Summary**: Ground-up UX assessment for showing multiple gym data side-by-side beautifully:
  - Overhaul JAB Boxing / navy styling tokens (`gyms.config.js` and `styles.css`) for high-contrast, premium aesthetic.
  - Multi-gym visual cues (gym badges/chips, subtle border tints, or gym-specific iconography) across cards and rows.

### Live-Verified Follow-ups (session 4, same day — using the real test@piersj.com account)
* **Verified live** via a real two-gym Chrome session (previously inaccessible to automation — the browser extension's tab group is isolated from manually-opened tabs, but a NEW tab in that group inherits the same login cookies, so opening one directly worked).
* **Row tinting — was a CSS specificity bug, now genuinely fixed.** The session-4 fix above shipped correctly, but a pre-existing rule (`#psycle-timetable-rows tr { background: var(--surface) !important; }`, two `#id` selectors) always won the cascade over the new one (one `#id` + attribute selector) — id-count is compared before class/attribute count regardless of `!important` on both sides or source order. Rewrote the tint rules to also key off `#psycle-timetable-rows`, matching specificity. Confirmed live: every `psycle-london` row now shares one background colour, every `jab-boxing` row a different one.
* **Instructor photos — a real, separate bug, now fixed.** Confirmed via a live capture of the raw CodexFit `/instructors` response: the photo field is `photo` (a direct S3 URL) — not `image_url`/`photo_url`, which is what `codexfit.js` had mapped since this was written, so `imageUrl` was silently `undefined` for every Psycle instructor, always. Also found: bio/Instagram/Spotify were **never wired for either gym** — `normalize.js`'s `makeInstructor()` (used by both `codexfit.js` and `marianatek.js`) hard-pruned every instructor down to `id`/`name`/`imageUrl` regardless of what either adapter set upstream, so MarianaTek's already-correct `bio`/`instagramUrl`/`instagramHandle`/`spotifyUrl` mapping was being silently discarded too. Fixed: `codexfit.js` now maps `imageUrl: i.photo` and passes through `metafields` (bio/instagram/spotify live under `metafields.description`/`instagram_handle`/`spotify_handle` — the client's `tooltips.js` already had fallback logic reading exactly this shape, it just never received it); `makeInstructor()` now passes through all five fields instead of dropping four of them. Confirmed live: Emma's tooltip now shows her photo, bio, keywords, Instagram, and Spotify link.
* **The config gear ("cog") is not a bug.** It's gated on `hasMap && hasPrefs` — i.e. only shows when a studio both has a floor plan AND the account already has a saved preference for it (it's a "reconfigure" affordance, not a "configure" one — first-time setup goes through the "Book"/modal flow instead). Checked the real account's `/api/studio-preferences` directly: **exactly one studio has a saved preference** (a JAB TRAIN studio) — matching the exactly one row that showed a gear. Working as designed; the confusion was over what the gear means, not a defect.
* **The Book button is now showing on most rows** (JAB Train, Psycle Ride Studio 1, JAB Boxing all confirmed live) — a real improvement from the collision fix. A few rows still show Quick-Book only (Reformer Studio at Oxford Circus among them) — checked the raw metadata and a **differently-located** "Reformer Studio" entry does report `hasLayout: true`, so this may be genuine per-studio floor-plan data incompleteness from CodexFit for that specific location (a real, distinct, lower-priority gap) rather than a residual collision bug — not fully confirmed, worth another look if it persists.
* **Verifying a fix live now requires clearing 3 separate caches**, not the 2 previously known — see [[prod-deploy-cache-gotcha]] memory, updated with the full procedure (service worker + CacheStorage, IndexedDB, and a genuine hard reload rather than an SPA hash-route navigation). A cold multi-gym timetable fetch against both live provider APIs took **~22 seconds** with every cache cleared — not a hang, just real cross-provider latency.

### Cross-Gym Metadata Lookup Collisions (Bug, found + fixed 2026-09-02, session 4)
* **Status**: ✅ Fixed
* **Severity**: P0/P1 mix — one path could silently write a spot-map preference to the wrong gym.
* **The pattern**: same root cause as session 3's gymId-threading bug, one layer deeper — every shared client-side lookup (`studioObjMap`, `studioMap`, `instructorMap`, `locationMap`, `eventTypeMap`, `eventTypeGroupMap` in `timetable.js`, plus ad hoc `metadata.*.find()` calls scattered across `timetable.js`/`settings.js`/`tooltips.js`) was keyed by bare provider id with no gym qualifier — a straight repeat of trap #11 (cross-gym numeric id collision), just for metadata instead of scheduler state.
* **Three live symptoms, one cause**: (1) "most classes only show Quick Book, no Book button, no config gear" — `hasMap`/`hasPrefs` resolved false because the studio lookup for a non-active gym's class either collided with the wrong gym's entry or (worse) `studio_preferences` was **never fanned out across gyms at all**, unlike bookings/credits/timetable. (2) Psycle instructor tooltip photos/bios broken — same bare-id `.find()` in `instructorTooltipHTML()`. (3) The Settings → Manage Spot Maps modal could **save a preference against the wrong gym** — `openStudioFloorPlanEditor`'s caller never threaded `studio.gymId` through, and `api.updateStudioPreferences()` had no `gymId` parameter at all.
* **Also found in the same pass**: `trimLocation(name, getGymContext().name)` used the globally *active* gym's name to strip a location's own prefix ("Psycle Shoreditch" → "Shoreditch") — worked only when Psycle happened to be active, which is why "Psycle " was showing unstripped in the merged view. Fixed at every call site to use the row's own `getGymShortName(event.gymId)`.
* **Fixed**: new `gymScopedGet(map, id, gymId)` helper (tries `${gymId}:${id}` then falls back to bare id); `api.getStudioPreferences()` now fans out across linked gyms (mirroring `getBookings`/`getCreditsByGym`), `api.updateStudioPreferences()` takes a `gymId` param; every unscoped `metadata.*.find()` across `timetable.js`/`settings.js`/`tooltips.js` now gym-qualifies the match. Full detail + audit trail in [modular-gyms/OUTSTANDING.md](file:///Users/pierswingfield/Desktop/AI%20Projects/psycle%20chrome/App/Documentation/Backlog/modular-gyms/OUTSTANDING.md) trap -1.
* **Also fixed this round (unrelated to the collision bug)**: "Train" (JAB's own discipline) was mislabeled "Conditioning" — a regression from the *previous* session's icon fix, which mapped the "train" keyword into the conditioning bucket instead of giving it its own label. Now keeps the conditioning icon but its own "Train" label.
* **Not verified live in a true multi-gym repro** — same caveat as session 3's fix: verified via full test suite (16 server + 51 client, unchanged) and a single-gym smoke test (Manage Spot Maps modal end-to-end, floor plan editor, no console errors), not an actual two-gym account.

### Cross-Gym Event Detail Calls (Bug, found + fixed 2026-09-02, session 3)
* **Status**: ✅ Fixed
* **Severity**: P0 — broke booking. Reported live as "All Psycle classes now say Failed to load slot layout" and "Error loading layout: Failed to load event details" after the merged multi-gym timetable (P1) went live.
* **Root cause**: every call site of `api.getEventDetails()`, `api.book()`, `api.joinWaitlist()`, `api.getStudioLayout()` passed no `gymId`, so each silently fell back to whichever gym was **currently active** — correct only by coincidence for a single-gym account. In the merged timetable, clicking a Psycle event while JAB is active (or vice versa) queried the wrong provider's `/api/events/:id` entirely. The API layer (`api.js`) already supported an explicit `gymId` param on every one of these methods; the bug was purely at the call sites, not the architecture.
* **Fixed**: threaded `event.gymId` (or the equivalent in scope — `c.gymId`, `group.event?.gymId`, a new `gymId` field added to `handleUpgradeClick`'s/`openUpgradeConfigModal`'s options object) through every call site across `timetable.js`, `bookings.js`, `settings.js` (via a `gymId` field already in its existing `options` bag), and `tooltips.js`. The occupancy tooltip's hover elements didn't carry gym identity at all — added `data-gym-id="${event.gymId}"` alongside the existing `data-id`, and the tooltip's local `eventDetailsCache` (keyed only by numeric event id) was changed to key on `${gymId}:${eventId}` — the same cross-gym-collision class of bug AGENTS.md already warns about for `scheduler.js`'s `eventCache` (two gyms can publish the same numeric event id).
* **Not verified live in a true multi-gym repro** (would need a real account linked to both gyms with JAB active while clicking a Psycle event) — verified instead by: full grep sweep confirming no remaining bare `getEventDetails(id)`/`book(id, slots)` calls, all 16 server + 51 client tests passing, and a single-gym smoke test confirming no regression.

### Timetable Polish Round (Design/Bug, 2026-09-02, session 3)
* **Status**: ✅ Fixed — full stakeholder feedback list addressed
* **Quick Book / Book same colour**: `styles.css`'s `.variant-success-muted` (the "Book" secondary button) was accidentally grouped into the same CSS rule as `.primary.variant-success` (the "Quick Book" primary button) — both rendered the identical solid accent background. Split into its own rule with a light green tint, visually distinct and receding behind the primary CTA.
* **Action buttons not fixed-width**: `.psycle-tt-seg` had only `min-width: 68px`, so "Quick Book"/"Book"/"Auto-Book"/"Debug" rendered at different widths depending on label length. Now a fixed `122px` (the caret/gear opts out via `:not(.psycle-tt-seg-caret)`, staying narrow) with `white-space: nowrap` so labels don't wrap.
* **Config gear appearing/disappearing — explained, not a bug**: the gear is gated on `hasMap` (`timetable.js:1108`) — it only shows for studios with a floor plan to configure. A studio with no floor plan (FCFS classes) correctly has nothing to configure, so the gear correctly disappears rather than showing a dead control.
* **Gym name chips not uniform width**: `.psycle-gym-chip` had no fixed width, so "PSYCLE" and "JAB" rendered at different widths. Added `min-width: 54px` — a static number is fine here (unlike class-type chips) since the gym set is small and both short names are known in advance.
* **Row background not tinted by gym identity**: added `data-gym` to every timetable row (desktop `<tr>` and mobile card) and matching CSS, reusing the exact same colours/opacities the Auto-Book/Bookings card tint already uses (`#B2503A` Psycle, `#18214D` JAB, both ~3% opacity) so a merged multi-gym timetable reads consistently with the rest of the app.
* **Desktop filter-bar ellipsis broken and unstyled**: `injectMobileFilterHamburger()`'s trigger button was only ever removed at the top of its own function — which only runs on the mobile branch. Resizing from mobile to desktop left the trigger stranded in the DOM: present, unstyled for the wider layout, its click handler pointing at a menu of mobile-only controls. Added the missing `else` branch to remove it when not mobile.
* **"Active" badge ambiguous for JAB**: read as "this is the active gym" (a real concept elsewhere in the app) rather than "your membership is active." Changed the pill text from "Active" to "Member"; the full sentence lives in the hover title.
* **Missing class-type icons**: `getDiscipline()`'s keyword regex didn't match "Lagree", "Train", or "Lift" — all three real class names visible in the very first screenshot shared this session — so they fell through to the generic dot icon. Added `lagree` to the reformer keywords, `train` to conditioning, `lift` to strength.
* All fixed via CSS/JS only, no server changes, no test regressions (16 server suites + 51 client tests still pass throughout).

### Header Credit Badges Show the Wrong Gym's Total (Bug, found 2026-09-02)
* **Status**: ✅ Fixed 2026-09-02
* **Fixed**: `updateCreditBadge()` (`client/src/main.js`) now fans out via new `api.getCreditsByGym()` (one `/api/credits` call per linked gym, above n=1 only — see D8) so each badge shows its own gym's balance; clicking a badge opens that gym's own credit-detail modal. `shortName` added to both `gyms.config.js` entries and threaded through `/api/gyms` → `loadGymContext()` → new `getGymShortName()` helper (`gym-context.js`), replacing the 3 hardcoded `'jab-boxing' ? 'JAB' : 'Psycle'` ternaries in `main.js`/`timetable.js` (`cards.js`'s `gymBrand()` intentionally left alone — it also carries a hand-drawn SVG logo per gym, not naturally config data).
* **Verified 2026-09-02, already satisfies the ask**: screenshotted the header badge — `psycle-hgb-name` (gym short name) + `psycle-hgb-pill` (rounded, distinctly-colored credit count) already render as a chip containing a visually distinct sub-chip, not a flat pair. No further markup change needed; the bug fix above was the actual gap.
* **Not a gap, verify only**: the Settings "switch gym" control (`settings.js:1091-1129`) still exists as the only way to change active gym — the stakeholder's ask to make the top bar the primary surface doesn't remove the need for gym *management* (link/unlink/re-auth) in Settings; see "Settings Redesign" below, which already covers folding this into a "Your Gyms" area.

### Timetable Gym Column (verify only — already implemented)
* **Status**: ✅ Appears done (and gym short-name hardcoding now fixed, see above), needs stakeholder re-check
* **Summary**: The stakeholder's feedback ("gym name should come after the time column, in its own column") is already the shipped layout: `timetable.js:884-891` header order is Time → Gym → Class → Instructor → Location/Studio → Status → Actions, and `timetable.js:1015` renders `<td class="col-gym">` as its own cell, separate from `<td class="col-class">`. Likely the feedback predates this row (or was seen on mobile, which is genuinely different — see below). Worth a quick screenshot check before doing any work here.
* **Gap that IS real**: the mobile card (`buildMobileClassRow()`, `timetable.js:1468-1508`) embeds the gym chip inline in `.psycle-mobile-top-line` alongside time/discipline/instructor — there's no equivalent "own column" concept on a card layout, so the mobile hierarchy question is still open and needs a UX decision (own line? leading badge?), not just a copy of the desktop fix.
* **Fixed 2026-09-02**: both desktop and mobile now use `getGymShortName()`, no more hardcoded ternary — mobile also previously showed the full "Psycle London" (via `event.gymName`) rather than a short chip, now consistent with desktop.

### Class Type Chip Uniform Sizing (Bug/Design)
* **Status**: ✅ Fixed 2026-09-02
* **Fixed**: `.ab-disc-tag` now defaults to content width (`min-width: 76px` floor) rather than a fixed 96px guess, and new `equalizeDiscTagWidths(container)` (`cards.js`) measures every chip actually rendered in a view and sets them all to the widest one's width via inline style, post-render. Wired into all 4 render sites that use `disciplineTag()`: `timetable.js` (`renderTimetableGrid`, covers both desktop and mobile rows in one call), `bookings.js` (`renderBookingsCards`/`renderWaitlistsCards`), `autobook.js` (`renderQueue`/`renderHistoryPage`). Visually verified in the browser: two chips with different-length labels ("RIDE" vs "BARRE") now render pixel-identical widths.

### "RECOVERY 2.0" Alias + Icon (Design)
* **Status**: ✅ Mostly already done, one gap fixed 2026-09-02
* **Turned out already done**: the chip already gets a steam/bath-style icon (`SVG_PATHS.recovery`, `cards.js:31` — three wavy steam lines over a tub base) and the chip label already always reads "Recovery" regardless of the raw class name (`getDiscipline()`'s `recovery` branch hardcodes the label). Neither needed work.
* **The real gap**: the **studio name** "RECOVERY 2.0" (JAB's actual room name from MarianaTek) rendered verbatim in the timetable's Location/Studio column — that's what the stakeholder was seeing, not the chip. Fixed with a new `displayStudioName()` helper (`cards.js`), scoped to that one exact studio name (not a generic "strip any 2.0" rule, which could mis-fire on a differently-versioned studio added later) — wired into the desktop row only (mobile cards don't render studio name, just location).

### Action Buttons: Unify Desktop and Mobile Layout (Design)
* **Status**: ✅ Already done — verified in browser 2026-09-02, no change needed
* **Finding**: this was already fixed by the time it was investigated. Screenshotted the desktop table's action column with a JS `matchMedia` override (browser resize tooling wasn't available in this environment): `.psycle-tt-actions`/`.psycle-tt-seg` (`styles.css:5466-5501`) already render as one flush, full-height, no-gap, borderless-radius rail anchored to the row's right edge — visually confirmed as "Auto-Book | ⚙ | Debug" sitting as one continuous strip, not separated floating pills. The only real difference from mobile's rail is icon+label orientation (horizontal row vs. vertical stack) — a reasonable adaptation to desktop's extra width, not an inconsistency. If this still reads as "floating" in a real screenshot at proper desktop width, it's worth a fresh look with an actual screenshot rather than more code reading — the CSS evidence and the forced-render screenshot both point the same way.

### Gym Logos in Visual Views (UX / Backlog)
* **Status**: ❌ Open (Backlog)
* **Summary**: Incorporate official gym brand logos/icons in timetable cards, filters, and booking cards where visually beneficial alongside gym badges.

### Settings Redesign & Discrete "Your Gyms" Architecture (Architecture / UX)
* **Status**: ✅ Phases 1–4 implemented and mechanically verified 2026-09-12; local mock browser smoke passed, live relogin acceptance open
* **Spec Link**: [settings-restructure.md](file:///Users/pierswingfield/Desktop/AI%20Projects/psycle%20chrome/App/Documentation/Backlog/settings-restructure.md) — current structure, scope audit, ASCII mockups, 4 phases
* **Implemented**: all four Auto-Upgrade settings are gym-scoped with an idempotent migration; `prefetchWeeks` remains account-scoped. One explicit-`gymId` renderer owns connection, membership/credits, booking window, Auto-Upgrade, spot maps, calendar and Profile Explorer. Settings now uses Account / Your Gyms / About, mounting that renderer inline for n=1 and in a drawer/full-screen mobile surface for n≥2.
* **Summary**: Refactor Settings pane from global controls to a clean, per-gym model:
  - **Discrete "Your Gyms" Area**: A dedicated management interface to view all connected gyms, link new gym accounts, re-authenticate, and unlink gyms.
  - **Per-Gym Settings Drawer/Modal**: Each gym card features a "Settings" button housing all settings specific to that gym:
    - Gym metadata & connection status
    - Credit balance / Membership details
    - Profile Explorer (viewing raw & normalized account payloads for that gym)
    - Booking & Cutoff Modifiers (moving out of the global settings list)
    - Booking preferences (auto-upgrade engine toggles, preferred spot maps)
  - **Remove Disconnected Global Controls**: Remove global "Booking & Cutoff Modifiers" and global "Profile Explorer" from the main settings pane.

### Card Typography & Text Style Consolidation (Design / UX)
* **Status**: ❌ Open (Backlog)
* **Summary**: Audit and simplify the typographic hierarchy across **My Bookings**, **Waitlists**, **Auto-Book Queue**, and **Auto-Upgrade** cards to eliminate visual clutter and ensure consistent font sizes, weights, and line heights.
* **Scope, confirmed 2026-09-02**: roughly **15–18 unique font-size/weight pairs** across the two files, all inline or per-class ad hoc, none centralized — `bookings.js` (~10 combos, classes `ab-card-toprow/when/meta/class/instructor/footer/rail`, lines 87-841) and `autobook.js` (~8 combos, lines 232-587). No shared typography scale exists to consolidate onto; one likely needs defining in `styles.css` first.

### Multi-Gym Buy Credits → "Credits & Membership" (Feature)
* **Status**: 🟡 Implemented 2026-09-12; mechanically verified, browser acceptance open
* **Spec Link**: [multi-gym-buy-credits.md](file:///Users/pierswingfield/Desktop/AI%20Projects/psycle%20chrome/App/Documentation/Backlog/multi-gym-buy-credits.md) — what's already done vs. speculative, ASCII mockup, 4 phases
* **Implemented**: normalized membership route and MarianaTek mapping; per-gym membership/credit sections; JAB-only tab visibility; config-driven gym website links; explicit purchasing-gym routing through checkout. The selector remains deferred because only Psycle is purchasable. `/bundles` is still one of the remaining `/api/proxy` callers.

### Multi-Gym Notifications & Calendar Verification (Testing / QA)
* **Status**: ❌ Open (Backlog)
* **Summary**: Perform comprehensive end-to-end testing of Web Push notifications (auto-book success, upgrade alerts, window reminders) and iCalendar feeds (`.ics` subscription) across accounts with multiple active gym links.

### Guest Pass Booking Flow for MarianaTek (Feature)
* **Status**: ❌ Open (Backlog)
* **Summary**: Support guest reservations on MarianaTek (`is_booked_for_me: false`, `guest_email`) drawing from the membership's monthly `guest_remaining_usage_count` (e.g. JAB's 2 monthly guest passes).

---

## 3. Phase 3: User-Agnostic Timetable & Real-Time Occupancy Caching (Architecture A1)

### User-Agnostic Timetable & Real-Time Occupancy Caching (Architecture A1)
* **Status**: ❌ Open (Phase 3)
* **Summary**:
  - **Schedule Layer** (catalogue, instructors, timetable dates): Globally cached per gym on server with ~5–15m TTL and opportunistic write-through when any user queries the timetable.
  - **Occupancy / Spot Layer**: Short TTL (~15–30s) server cache shared across users viewing the same class; client pulls fresh on booking/modal open to prevent peak race conditions.
  - **Poller / Scheduler Integration**: Background cron periodically warms enabled gym timetables.

### Account recovery — self-service mechanism (admin reset is the interim)
* **Status**: 🟡 Admin reset built 2026-08-31. **No self-service reset** — mechanism still to be chosen.
* **Interim, shipped**: `POST /api/admin/users/:id/reset-password` + a button in the admin panel. The server generates a strong temporary password and returns it **once** for the admin to relay out-of-band; the admin never chooses it and it cannot be read back. Clears stored gym credentials by default (opt-out checkbox for a routine forgotten password) — per Decision D5, an account that needed recovering is not assumed safe. Links, queues, spot maps and priority tiers survive; the user re-authenticates each gym.
* **Why gym-login recovery is not an option**: it was built and removed the same day (Decision D5). It re-coupled the account to the gym — cancel the membership and you can't recover — and silently promoted the gym password to a permanent master key for the Sweat Assistant account, inheriting the gym's password rules and security posture. **Do not reintroduce it.**

**What Cloudflare Access actually is here** (checked against the live config, 2026-08-31 — re-verify before relying on it):
* **Zero identity providers are configured**, so Access falls back to its built-in **One-Time PIN emailed to the address you type**. Access, in this deployment, *is* an email-verification service you already run.
* `*.wingfield.tech` catch-all (covers `sweat` and `sweat-dev`) → allow **`piers@piersj.com` only**.
* `psycle.wingfield.tech` → its own app → allow **Everyone** (still OTP-authenticates, any address).
* `psycle.wingfield.tech/api/calendar/*` → **bypass**, so native calendar clients can fetch the `.ics`. **No Access identity on that path.**
* Both hostnames serve the same prod container. Prod currently has **3 accounts**.

**Candidates:**
1. **Cloudflare Access identity** — verify the Cloudflare-signed `Cf-Access-Jwt-Assertion` against the team JWKS, pin the `aud` to this app, and allow a reset when the token's email matches the account. No dependency, no mail server, no stored secret. Sound because an attacker can only obtain a token for an address they can receive a PIN at. **Footgun**: you must verify the *signed JWT*, never the plaintext `Cf-Access-Authenticated-User-Email` header — anyone hitting the bypassed `/api/calendar/*` path can set that header by hand. Caveats: `sweat.wingfield.tech` admits only one email today, so other accounts would need adding to the policy or would have to use `psycle.wingfield.tech`; and it ties recovery to Access staying in front of the app. **~half a day.**
2. **Email reset link** — the universal mechanism, and the only one that survives Access being removed. Needs an SMTP credential and deliverability care; this deployment sends no mail at all today. Largely duplicates what Access is already doing. **~a day, plus an ongoing account.**
3. **Recovery codes** — single-use codes issued at signup, hashed at rest. Zero infrastructure and strong, but front-loads friction and people lose them. Best as a secondary factor, not the only route. **~2 hours.**
4. **Passkeys** — replaces the password entirely, syncs via iCloud/Google keychains, and is itself a recovery factor (it would also close the zero-gym hole). Needs `@simplewebauthn/server` + `/browser`; hand-rolling WebAuthn means CBOR, COSE, attestation and signature verification, which is a security project in itself. **1–2 days.**

* **Recommendation**: (1) Access identity when self-service is wanted, with the admin reset staying as the backstop. Skip (2) unless the user base grows beyond people you'd add to a policy. Treat (4) as its own piece of work rather than a recovery mechanism.
* **Settled regardless of choice**: a successful recovery resets **all** stored gym credentials via `db.resetGymCredentials()`.

### Account setup — remaining gaps
* **Status**: 🟡 Core built 2026-08-31. **Not yet browser-click-verified.**
* **The agreed shape** (stakeholder): account setup is **email + password**; gym authentication is **added afterwards as separate logins**.
* **Built**: `POST /api/auth/signup` (gym-independent), three-mode auth screen (sign in / create account / reset password), a "Connect a gym" screen for accounts with none, and **409 `NO_GYM_LINKED`** on gym-scoped routes so a gym-less account isn't sent round a 401 login loop.
* **Remaining**:
  1. **Legacy accounts with a gym password under 8 characters never migrate.** `setAccountPassword` enforces the minimum; seeding fails (caught, logged, login still succeeds) and the account stays gym-coupled forever. Needs a one-time "set your Sweat Assistant password" prompt, or an explicit decision to leave them.
  2. **No migration observability.** Nothing reports how many accounts have an SA password; the admin panel shows linked gyms but not `password_hash IS NULL`. Cheapest item here, and it sizes the rest.
  3. **`users.email` doubles as the SA username and has no way to change it.** The *divergence* half is fixed — `user_gyms.gym_email` (WP-D5) holds each gym's own login, and NULL there means "re-link needed", never "fall back to `users.email`". What remains is letting someone change their Sweat Assistant email.
* **Related tech debt**: `users.encrypted_password` is `NOT NULL` but vestigial since WP-D3. `createAccount` writes `''` and `mergeUserWithGym` coerces empty → null so nothing mistakes it for a credential. Dropping it means rebuilding `users`, which ~10 tables cascade-reference — fold into a future `users` migration rather than doing it alone.

## 4. Advanced Backlog Items

### In-App 3-D Secure Support
* **Status**: ❌ Open (partial)
* **Spec Link**: [3d_secure_checkout.md](file:///Users/pierswingfield/Desktop/AI%20Projects/psycle%20chrome/App/Documentation/Backlog/3d_secure_checkout.md)
* **Summary**: Embed Stripe.js in the PWA client to complete the 3DS verification modal in-app for credit purchases, rather than bouncing users to the external Shopify site checkout.

### Sweat Assistant Multi-Gym Architecture
* **Status**: 🟡 Core architecture, merged views, Credits & Membership and Settings restructuring are implemented. The Node 20 mechanical suite is green and local one-/two-gym browser smoke passed. Production readiness remains gated by the current live acceptance matrix.
* **Current handoff and build order**: [modular-gyms/OUTSTANDING.md](file:///Users/pierswingfield/Desktop/AI%20Projects/psycle%20chrome/App/Documentation/Backlog/modular-gyms/OUTSTANDING.md) — answers what remains in one read. **Start here.**
* **Live status board**: [modular-gyms/PROGRESS.md](file:///Users/pierswingfield/Desktop/AI%20Projects/psycle%20chrome/App/Documentation/Backlog/modular-gyms/PROGRESS.md) — per-work-package detail.
* **The goal, stated precisely** (stakeholder, 2026-08-31): this is **not** bolting MarianaTek onto CodexFit as an extension. Every gym is an equal upstream service. Three layers: **platform module** (`providers/*.js` — the protocol, shared by every tenant on that platform), **gym config** (`gyms.config.js` — the instance and its policy), **app** (everything else — normalized types and capability flags only). MarianaTek is a platform many gyms use, JAB being one; so is CodexFit, Psycle being one.
* **The acceptance test**: delete `psycle-london` from `gyms.config.js` and nothing outside `providers/codexfit.js` should break. Corollary: **a third gym should need zero edits outside `providers/` and `gyms.config.js`.** Enforced by `server/test-no-gym-privilege.js`.
* **Implemented**: per-gym identity and persistence, runtime/cache isolation, normalized provider data, capability gating, gym-owned booking-window policy, queue-driven release scheduling, MarianaTek adapter/write paths, eligibility, sequential linking, and merged multi-gym views with gym-qualified actions and metadata.
* **Open**: live acceptance across both gyms; remaining visual/parity/proxy cleanup; push/calendar verification; and a real expired-session check for the new re-authentication warning. Warm timetable performance and loading skeletons were completed and archived on 2026-09-14.
* **History**: the superseded 2026-09-02 readiness snapshot is preserved in [modular-gyms/ARCHIVE-2026-09-02.md](file:///Users/pierswingfield/Desktop/AI%20Projects/psycle%20chrome/App/Documentation/Backlog/modular-gyms/ARCHIVE-2026-09-02.md).

### Single Sweat Assistant Login, Multiple Per-Gym Accounts
* **Status**: ✅ Built 2026-08-31 (WP-C2), extended by WP-D5 (`user_gyms.gym_email`). Server resolution, SA-native identity, link/unlink/re-auth, signup and the Settings UI are all in. The n=1/n≥2 Settings presentation and local mock gym-management surfaces were browser-smoked on 2026-09-12; true live multi-gym acceptance remains open.
* Remaining follow-ups live in *Account setup & recovery* above and in [modular-gyms/OUTSTANDING.md](file:///Users/pierswingfield/Desktop/AI%20Projects/psycle%20chrome/App/Documentation/Backlog/modular-gyms/OUTSTANDING.md).

### CodexFit 429/403 Distress Abort (Tech Debt)
* **Status**: ❌ Open
* **Summary**: Detect when CodexFit begins returning HTTP 429 or 403 blocks during landrush booking execution. In state of distress, abort the remaining queue to protect the server's egress IP and push-notify users.

### Track Relogin Failures per User (Observability)
* **Status**: ❌ Open
* **Summary**: Add database fields to track credential failures during automatic relogins. Proactively flag broken credentials on the Admin Dashboard before Monday release runs.

### SQLite Database Backup Mechanism (DevOps)
* **Status**: ❌ Open
* **Summary**: Set up a background cron backup task on the Pi to back up the SQLite database to a local file volume and prune snapshots older than 14 days.

### Per-User Key Derivation (Security)
* **Status**: ❌ Open
* **Summary**: Derive individual AES encryption keys for each user using HKDF, combining the system master key with unique user-record salts.

### PostgreSQL Migration (Scale)
* **Status**: ❌ Open
* **Summary**: Transition database storage from `better-sqlite3` to PostgreSQL to improve concurrent write performance and simplify database orchestration in production.

### Competing Booking Detection & Conflict Warning (UX)
* **Status**: ❌ Open
* **Summary**: Analyze the scheduler queue to detect when multiple users are targeting the identical slot of a class, and warn them in-app so they can select a fallback option.

### Structured Logging & Metrics (Telemetry)
* **Status**: ❌ Open
* **Summary**: Replace standard `console.log` statements with structured JSON logging and expose a Prometheus metrics endpoint to monitor success rates and API latencies.

### Username-Based Social Class Sharing (Feature / Social)
* **Status**: ❌ Open
* **Spec Link**: [social-class-sharing.md](file:///Users/pierswingfield/Desktop/AI%20Projects/psycle%20chrome/App/Documentation/Backlog/social-class-sharing.md)
* **Summary**: Allow users to connect via unique Sweat Assistant usernames (`@username`) and view attending mutual friends directly in the Web UI (timetable chips, class detail modals, studio spot map highlights) and optionally enrich personal iCalendar feeds (`.ics` descriptions) or subscribe to a dedicated friends workout feed.

### Model Context Protocol (MCP) Server for AI Integration (Integration / AI)
* **Status**: ❌ Open
* **Spec Link**: [mcp-ai-server.md](file:///Users/pierswingfield/Desktop/AI%20Projects/psycle%20chrome/App/Documentation/Backlog/mcp-ai-server.md)
* **Summary**: Expose an MCP server via local `stdio` CLI and authenticated remote Server-Sent Events (`/api/mcp/sse`) with personal access tokens, enabling AI assistants (Claude Desktop, Cursor, Antigravity, custom agents) to query multi-gym timetables, inspect bookings and credit balances, manage the auto-book queue, and execute class reservations safely.

---
