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

- [ ] C5-1 has a server test: pause, add credits, confirm the monitor resumes.
- [ ] C5-2 is verified live: a favourite rule produces a real queued auto-book at the next
      release for each gym.
