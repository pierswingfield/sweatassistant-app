# Sweat Assistant — Completed Work Archive

Finished items, moved out of [BACKLOG.md](../BACKLOG.md) so the live backlog stays short
enough to read in one pass (it is loaded into agent context every session; the history is not).

**Nothing here is actionable.** Read it only when you need to know *why* something is the way
it is, or whether a problem has been solved before. For current work, see BACKLOG.md; for the
multi-gym refactor's live status board, see [modular-gyms/PROGRESS.md](modular-gyms/PROGRESS.md).

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
