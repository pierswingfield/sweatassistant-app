# C5 — Auto-book and auto-upgrade gaps

**Priority:** P2 (C5-1, C5-3) · P3 (C5-2) · **Size:** ~2.5 days · **Depends on:** C4 for C5-2 · **Blocks:** nothing

> **Verify first:** before changing anything for an item, confirm its basis in the code **and**, for anything user-visible, **in a real browser** (CDP :9222 or Claude for Chrome). For server-only items, use a failing test or a request. Record the evidence. If a browser check is needed and no browser is available, stop with `BLOCKED`. See [AGENT_PROTOCOL.md](AGENT_PROTOCOL.md).

The scheduler core (queue-driven release wake clock, per-gym policies, native MarianaTek spot
swap) is done and live-verified. These are the remaining gaps.

| # | Item | Evidence (verified 2026-09-26) | Est. |
|---|---|---|---|
| C5-1 | **Auto-upgrade monitors stuck in `paused_no_credits` never resume.** The poller sets the status, but `getActiveAutoUpgrades` only selects `active`, so a monitor paused for credits stays dead after you top up. Re-check paused monitors when credits change, or on each poll. | `server/poller.js` L242; `server/db.js` L1285 | 2–3 h |
| C5-2 | **Build Auto-Book Favourites (P3, decided 2026-09-26: build, low priority).** The UI saves `autoBookFavourites` to settings, but no server code turns favourites into queue jobs, and the button was removed from the main controls, leaving the modal orphaned. Build: (a) a favourite rule model (gym, discipline, instructor, weekday and time, spot preference); (b) scheduler expansion of rules into queue entries at each gym's release; (c) restore the button; (d) make the modal copy match what it actually does [QA-15]. Keep the UI hidden until it works. [QA-14, QA-15] | `client/src/ui/autobook.js` L218–301; nothing in `server/scheduler.js` | ~1–1.5 days |
| C5-3 | **Competing booking detection.** Warn when two queued auto-books target the same slot, or the same time across gyms. | Nothing in `scheduler.js` or the routes | 3–4 h |

## Done when

- [x] C5-1 has a server test: pause, add credits, confirm the monitor resumes. (2026-09-28, `server/test-poller-resume.js`)
- [ ] C5-2 is verified live: a favourite rule produces a real queued auto-book at the next
      release for each gym.

## C5-1 — done 2026-09-28

**Basis (verified before changing):** `server/poller.js` set `paused_no_credits` (pause site, `attemptUpgradeSlot`), `db.getActiveAutoUpgrades()` selects `status = 'active'` only, and nothing else ever moved the status back. New `server/test-poller-resume.js` failed on the pre-fix code at "monitor resumes once credits exist" (`actual 'paused_no_credits'`, expected `'active'`). Server-only item: no UI surface changed, so no browser check.

**Root cause:** the poll loop only ever read `active` rows, so a pause was terminal.

**Fix:**
- `server/db.js` `getPausedNoCreditsAutoUpgrades()` (~L1290): cross-user scanner, deliberately not gym-filtered (returns `gym_id` per row).
- `server/poller.js` `resumePausedUpgrades()` (~L418), called first in `executeAutoUpgradeChecks()` (~L493); pure `hasUsableCredits()` (~L390).

**Design decisions:**
- *Resume rule:* usable credits (not guest-only, not expired, and of an accepted type where the event is in the shared event cache) total at least `credits.required` (default 1). Absent requirement info falls back to cost 1 / any type, never "free". The event is NOT fetched just for this (no extra load); when uncached the check is permissive, and the same `hasUsableCredits` now also gates the pause site, so a monitor cannot flap pause/resume (the old pause check counted guest-only and wrong-type credits as "has credits").
- *Per row, per gym:* credits are read with the row's own gym session (`getUserSession(userId, row.gym_id)`), one `provider.getCredits` per user+gym per cycle shared by all that user's paused monitors. Skipped entirely while `isGymRateLimited(gymId)` (C2-3). A failed or session-less read leaves the monitor paused ("not loaded" is not "has credits").
- *Cadence:* paused monitors are re-checked at most every 15 min (jittered, via `shouldCheckUpgrade`) whatever the user's interval, since no one races for a seat while out of credits. A resumed row gets `last_checked_at = NULL` so its first attempt runs in the same cycle.
- *Cutoffs:* a paused monitor never resumes into a dead window. Under 1h, or under 12h without an unspent `keepOriginalOnCutoff`, it is moved to `stopped` (as the active loop would) instead of lingering as "paused" forever. Under 12h with `keepOriginalOnCutoff` and no prior attempt it resumes so its one final attempt can run. `autoUpgradeEnabled === false` leaves it paused.
- *Notification:* fits no existing type (`upgrade` means upgrade success), so it uses the same direct `pushService.sendNotification` the pause message uses ("Upgrade Resumed"). A dedicated preference-gated type is a possible follow-up.
- *UI copy:* `autoupgrade.js` shows "Insufficient Credits" for `paused_no_credits`; accurate, left alone.

**Tests:** `server/test-poller-resume.js` (10 cases: zero credits, guest-only, read failure, top-up resumes, C2-3 backoff, one read for three monitors, interval respected, cutoff/1h stop, keepOriginal final attempt, accepted-type awareness).

## C5-3 — done 2026-09-28

> **Amended by [U1-6](U1-ux-bug-fixes.md) (2026-09-28):** an overlap is no longer committed and then announced with a toast. `POST /api/auto-book` now answers 409 `OVERLAP_CONFIRM_REQUIRED` (nothing inserted) until resubmitted with `confirmOverlap: true`, and the client shows a confirmation modal. The duplicate rule, warning codes and `GET` annotations below are unchanged.

**Basis (verified before changing):** `grep` of `server/` and `client/src/` for any queue-conflict logic found nothing: `POST /api/auto-book` inserted unconditionally, so the same class could be queued twice and a Psycle class could be queued over a JAB class at the same time. A second bug turned up on the client: `api.addAutoBooking()` returned `res.json()` for any status, so any refusal (429 quota today, 409 tomorrow) was announced as "Successfully scheduled". Nothing existed to make a failing test for, so the new suite was written alongside the code and asserts the previously-impossible outcomes (409, warnings).

**Design decisions:**
- *Pure detector* `server/competing-bookings.js` (`detectCompetingBookings`, `detectQueueConflicts`): no db, provider, or gym literals. Duplicate = same `gymId` + `eventId` (provider ids collide across gyms, so the gym is part of the identity). Overlap = intervals intersect, any gym; back-to-back is not an overlap. Instants are parsed in each row's own gym zone (`gyms.config.js timezone`) because CodexFit serves naive datetimes; an ISO string with an offset ignores the zone.
- *Warn vs 409:* only an exact duplicate (still-pending, same gym + event) is refused with `409 DUPLICATE_AUTO_BOOK`: a second entry can never help (at best a no-op, at worst a double claim) and the client would otherwise announce success for nothing. Everything else is a warning: auto-book is speculative and a member may deliberately queue two alternatives and cancel one, which the server can't know. Warnings ride on the 200 response (`warnings[]`), so the queue is never blocked.
- *Codes:* `DUPLICATE_QUEUED` (error), `ALREADY_BOOKED`, `OVERLAP_QUEUED`, `OVERLAP_BOOKED` (warnings, with `crossGym`). (c) and the booked-overlap use `booking_cache` (client/poller-synced, so it may lag the gym a little: acceptable for a warning, and it costs no live gym call).
- *GET is cheap:* `GET /api/auto-book` annotates every row with `warnings`, judged against the member's whole queue + bookings (not the `gymId` filter), so a per-gym view still shows a cross-gym clash and both halves of a clash are flagged.
- *Duration:* new nullable `auto_bookings.duration_min` (`db.js`), sent by the timetable as `durationMin`. Rows without one (legacy rows, and Psycle in the dev mock, which publishes no duration) assume 45 min, the low end of typical classes, to under-warn rather than cry wolf on back-to-back classes.
- Cross-user contention (`claimedSlots`) untouched. Detection only reads the requesting user's own rows.

**Fix:** `server/competing-bookings.js`; `server/server.js` `competingContextFor` + `GET`/`POST /api/auto-book` (409 + warnings); `server/db.js` `duration_min` column, `addAutoBooking(..., durationMin)`, `getPendingAutoBookingsAllGyms`, `getBookingCacheAllGyms`; `client/src/api.js addAutoBooking` (now throws on non-2xx); `client/src/ui/timetable.js` (sends `durationMin`, warning toast per warning); `client/src/ui/autobook.js` (`.ab-clash-warning` line on each card, HTML-escaped) and `client/src/styles.css` (`.ab-credit-warning.ab-clash-warning`, reuses the existing warning treatment).

**Tests:** `server/test-competing-bookings.js`: unit (duplicates, cross-gym id collision, same/cross-gym overlap, back-to-back, duration + default, naive datetimes in two zones, already-booked, whole-queue analysis) and HTTP over the dev mocks with a two-gym account (first entry clean, duplicate -> 409 and not inserted, cross-gym overlap -> 200 + warning, GET annotates both halves and survives a per-gym filter, other accounts unaffected, deleting one side clears the other).

**Browser evidence (real Chrome via CDP, one own tab, local mock, `dev@psycle.com` + JAB linked via `dev@jabboxing.mock`):** queued Psycle Barre 55 (19:30) and JAB Technical Sparring (19:30) and JAB Core & Glutes (20:00) on 30 Sep. The Auto-Book tab shows amber warning lines on each clashing card, e.g. "Overlaps another queued class: Barre 55 at Psycle, Wed 30 Sep 19:30." on the JAB card, and the non-clashing 1 Oct entry has none. A duplicate `api.addAutoBooking` now rejects with "This class is already in your auto-book queue." **Not covered in-browser:** the timetable toast for a successful add-with-warning, because the mock has no unreleased class, and the timetable only offers Auto-Book for classes not yet released (mock rows only offer Quick-Book). The toast is a one-line loop over the same `warnings` array; the API contract behind it is tested.
