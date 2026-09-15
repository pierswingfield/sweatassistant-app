# Sweat Assistant — Completed Work Archive

Finished items, moved out of [BACKLOG.md](../BACKLOG.md) so the live backlog stays short
enough to read in one pass (it is loaded into agent context every session; the history is not).

**Nothing here is actionable.** Read it only when you need to know *why* something is the way
it is, or whether a problem has been solved before. For current work, see BACKLOG.md; for the
multi-gym refactor's live status board, see [modular-gyms/PROGRESS.md](modular-gyms/PROGRESS.md).

---

## My Bookings, mobile timetable, and filter fixes (2026-09-15)

### My Bookings instructor photos missing until you left the tab and came back
* **Root cause**: `metadata.instructors` (the array `instructorAvatar()` looks a photo up in) is
  only populated by the Timetable tab's own prefetch. Landing straight on My Bookings — a
  reload, or the app's initial tab — left it empty for the whole session until the user
  visited Timetable and back.
* **Deeper issue for JAB specifically**: even once metadata loaded, `instructorAvatar()` did a
  NAME lookup against it — but a MarianaTek gym's `metadata.instructors` is derived from
  whatever's currently in its public class-list window (`marianatek.js fetchMetadata`), which
  does not reliably include every class a member has already booked. The same instructor would
  resolve on one page load and silently miss on the next, independent of image loading.
* **Fix**: `bookings.js` now loads metadata itself if missing and repaints once it lands
  (`loadMetadata` exported from `timetable.js`). More importantly, `instructorAvatar()`
  (`tooltips.js`) now takes an optional `directUrl` and prefers the photo already embedded on
  the booking's own event object (`event.instructors[0].thumbUrl/imageUrl`, which MarianaTek
  always populates) — the metadata name-lookup is now only a fallback, used for CodexFit/Psycle
  (whose per-event instructor objects never carry a photo) and for Auto-Book/Auto-Upgrade rows
  (which only store an instructor name in their DB rows). Also dropped `loading="lazy"` on the
  avatar `<img>`: these cards can repaint several times in quick succession as data arrives, and
  a lazy image whose element gets replaced before the browser schedules its viewport check never
  starts loading at all.

### Timetable row backgrounds broke out of the container's rounded corners
* **Cause**: `.psycle-table-container` has `border-radius: 16px` but no `overflow` set, so a
  row's hard-cornered background (hover tint, or the per-gym tint) painted flush past the
  rounded corner on the first/last row.
* **Fix**: `overflow: hidden` on the container. The table doesn't scroll independently (the
  panel body does), so this never fights a scrollbar.

### Mobile timetable: overflow menu duplicated every action
* **Cause**: `buildMobileClassRow()` called `buildActionMenuElement(menuItems)` — which already
  renders every item — then ran the exact same rendering loop a second time over the same
  `menuItems` array, appending duplicate rows into the same menu. Desktop's equivalent
  (`buildDesktopActions`) never had the extra loop.
* **Fix**: removed the redundant loop.

### Mobile timetable: a booked class showed "Edit" as its one visible button, not "Cancel"
* **Cause**: mobile shows exactly one visible action button per row; `buildActionModel()` sets
  primary="Edit" / secondary="Cancel" for a booked class, which is a fine pair when both show
  (desktop shows both directly) but meant Cancel — the action people actually reach for — was
  buried one tap deeper in the overflow menu.
* **Fix**: mobile now swaps them when the secondary is a cancel action — Cancel becomes the
  visible button, Edit moves into the overflow menu. Desktop is unaffected.

### Filter dropdowns didn't show or group by gym
* See [Backlog/timetable-and-credits.md](timetable-and-credits.md) T4 for the full writeup —
  location/instructor grouping + disambiguation, class-type coarse bucketing, the
  `mergeMetadataFromEvents()` missing-`gymId` gap it exposed, and the `classroom_name` vs
  `class_type.name` discipline-sourcing bug for JAB found while live-testing it.

---

## Timetable loading performance and skeletons (2026-09-14)

### Slow warm-cache timetable refresh
* **Measured cause**: a local warm reload showed IndexedDB at 1.3 ms and metadata-map rebuilding at 0.2 ms. The avoidable delays were the row renderer awaiting Auto-Book plus studio-preference reads (23.1 ms) and metadata being awaited before the timetable cache was read (14.3 ms).
* **Fix**: cached rows now paint from in-memory action state; metadata, bookings, waitlists, Auto-Book and studio preferences refresh together in the background. The merged timetable/filter/event cache is account-scoped so two Sweat Assistant users cannot share the new unified cache.
* **Result**: the comparable cached render fell from 29.7 ms to 3.4 ms; render prerequisites fell from 23.1 ms to 0 ms. Browser timings remain available as bounded `psycle-timetable-performance` samples for future diagnosis.

### Structured loading placeholders
* **Resolution**: shared accessible row/card skeletons now cover cold timetable, bookings, waitlists, Auto-Book history/queue and Auto-Upgrade monitor loads, including responsive and reduced-motion treatment.
* **Verification**: 16/16 server suites, 60/60 client tests and the production client build passed under Node.js 20.19.0. Local warm-cache browser smoke passed; no production deployment or live multi-gym acceptance was performed.

### Timetable gym-chip legibility
* **Resolution**: increased the shared gym attribution chip from 10 px to 11 px while retaining its fixed 54 px minimum width, so Psycle and JAB labels remain aligned.

### Unified multi-gym views and per-gym Profile Explorer
* **Resolution**: timetable, bookings, waitlists and automation lists merge linked gyms while preserving per-row `gymId` routing and the n=1 path. Profile Explorer is part of the shared explicit-gym Settings renderer and supports normalized/raw provider data rather than remaining a CodexFit-only global pane.

---

## Fixed during the multi-gym refactor (2026-08-31)

### Class types rendering as "CLASS" on the timetable
* **Was**: our regression, not a Psycle JSON change (confirmed by comparing prod against dev).
* **Root cause**: the real `GET /events` returns events **by reference** (`event_type_id` etc.) plus a sibling `relations` bag. `codexfit.fetchTimetable()` read `.data` and discarded `relations`, so normalized events had no `discipline`/`studioName`/`locationName`/`instructors`. The client's `mergeRelations()` had been silently compensating until WP-C1 removed it.
* **Why no test caught it**: `mock.js`'s `/events` embedded the relations **inline** and returned a bare array — more generous than the real API. The mock now mirrors the real `{data, relations}` envelope, so this bug class is catchable.
* **Fix**: `fetchTimetable()` resolves each response's relations via `resolveEventRelations()` (made non-destructive so it never blanks an inline value). Regression assertion: every normalized event must resolve a discipline.

### Psycle booking-window change (fortnight standard + day-granular member tiers)
* **What changed** (Psycle, 2026-08-31): standard window moved from 8 days after the release Monday to a **fortnight** (14). Membership tiers now extend by **days**: Psycle 10 +2 (Thursday), Psycle 15 +3 (Friday), Unlimited +8. **Confirmed with a member** — the website copy was accurate.
* **Why it mattered**: `detectBookingWindow()` snapped every window to a whole-week tier (8/15/22/29). Day-granular tiers can't be represented, so 3 of 4 were wrong **in both directions** — standard 14→15 (over-runs: auto-book can compute an earlier release Monday for a boundary class and fire a week early, burning the queue entry), Psycle 10 16→15, Psycle 15 17→15. Only Unlimited (22) survived, coincidentally.
* **Fix**: detection no longer snaps — it uses the exact day count from the server-authoritative profile cutoff. Whole-week helpers survive only for the debug override and the legacy pre-detection path. Legacy base 8 → 14. Added `manualBookingWindowDays` (debug) and a 1–35 day clamp. `server/test-booking-window.js` pins the tiers and asserts the hand-mirrored client/server `getBookingOffset` stay identical.
* **Still open**: the Advanced Booking Credit floor (`countExtendedBookingCredits` forces 15 days) — see BACKLOG.md.

---

## Earlier completed items

### Timetable Scheduled Indicators (Bug)
* **Status**: ✅ Completed
* **Resolution**: Standardized the event ID resolution in `client/src/ui/timetable.js` mapping `autoBookedIds` correctly to `x.event_id || x.eventId` (DB schema mapping) to ensure scheduled status is shown accurately.

### Deep Link Notifications (Feature)
* **Status**: ✅ Completed
* **Resolution**: Updated `client/public/sw.js` and `client/src/main.js` to support deep linking on Web Push notifications. Clicking a booking or upgrade notification now focuses the open PWA window and navigates to the `#my-bookings` tab.

### Multi-spot Auto-Upgrades (Bug)
* **Status**: ✅ Completed
* **Resolution**: Solved concurrent booking ID mapping in `scheduler.js` and active monitor mapping in `admin.js`. The scheduler maps each spot individually, and the database stores unique `booking_id` properties for each slot, allowing the poller to track multiple upgrade monitors for the same class concurrently.

### Auto-Upgrade Poller Cancel Boundary (Enhancement)
* **Status**: ✅ Completed
* **Resolution**: Implemented a `CUTOFF_BUFFER_S` of 5 seconds in `server/poller.js`. Auto-upgrade polling now stops 5 seconds before the 12-hour free cancellation boundary to avoid race conditions that could lead to late cancellation penalties.

### Unauthenticated Public API Requests (Security)
* **Status**: ✅ Completed
* **Resolution**: Modified `server/server.js` public paths GET requests (e.g. `/events`, `/studios`) to query CodexFit directly without passing authentication tokens, limiting authorized token hits. Added a safety bypass for `dev@psycle.com` to prevent production leakage into mock environments. Also updated client-side receive listener in `main.js` to clear IndexedDB cache immediately on push, avoiding flash-of-stale-content visual bugs.
