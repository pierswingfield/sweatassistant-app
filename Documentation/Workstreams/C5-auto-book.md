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
