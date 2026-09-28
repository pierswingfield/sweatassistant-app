# U2 — Shared components and accessibility

**Priority:** P2 · **Size:** ~2–3 days · **Depends on:** nothing (best after C4) · **Blocks:** U3 in part

> **Verify first:** before changing anything for an item, confirm its basis in the code **and**, for anything user-visible, **in a real browser** (CDP :9222 or Claude for Chrome). For server-only items, use a failing test or a request. Record the evidence. If a browser check is needed and no browser is available, stop with `BLOCKED`. See [AGENT_PROTOCOL.md](AGENT_PROTOCOL.md).

Consolidate duplicated UI into shared components first. Accessibility then gets fixed once,
instead of in every copy.

| # | Item | Evidence (verified 2026-09-26) | Depends on | Est. |
|---|---|---|---|---|
| U2-1 | **Shared `openModal()` shell.** Modals are handled two ways today: static `.psycle-modal` elements and ad-hoc overlay divs. One shell should own open, close, Esc, backdrop and scroll-lock. [B3] | `client/src/main.js` ~L1373–1416 | — | 1 day |
| U2-2 | **Modal focus trap and focus return.** No focus-trap code exists anywhere. `:focus-visible` styles do exist. [A3] | — | U2-1 | 2 h |
| U2-3 | ✅ *pulled forward into launch 2026-09-28, done* **`aria-live` on auto-book status updates.** Toasts have it; the SSE status line in the Auto-Book tab doesn't, so screen readers miss "Booked!". [A1] | `client/src/ui/autobook.js` ~L129–153 | — | 30 min |
| U2-4 | **Shared `renderEmptyState()`.** Auto-Book, Bookings, Credits and Auto-Upgrade each hand-roll their own empty state. [B2] | No shared helper in `cards.js` | — | 2–3 h |
| U2-5 | **Implement `TIMETABLE_FILTER_DESIGN_BRIEF.md`** (timetable filter redesign). Added 2026-09-27 at the user's request. Brief: [`TIMETABLE_FILTER_DESIGN_BRIEF.md`](../TIMETABLE_FILTER_DESIGN_BRIEF.md). It covers the mobile filter bar, the active-criteria chips and the filter bottom sheet, and nothing else. Size this item from the brief before starting. Filters are gym-grouped and must stay per-gym correct (see AGENTS.md: `psycleDefaultFilters` has no bare-key fallback; string ids via `sameId()`). Do it after C4, because it changes the timetable, the main acceptance screen. | `client/src/ui/timetable.js` filters | C4 | TBD from brief |

Design reference: [`DESIGN.md`](../DESIGN.md). Original audit:
[`Archive/…/ui-ux-sweep.md`](../Archive/2026-09-26/Backlog/ui-ux-sweep.md).

## U2-3 — `aria-live` on the auto-book SSE status line (pulled forward into launch 2026-09-28) — DONE

- **Basis (real Chrome 154 via raw CDP, local mock, `dev@psycle.com`, one tab):** with the pre-change
  `autobook.js`, a queued class plus `POST /api/simulate-release` produced a `.autobook-status-line` with
  `role`, `aria-live` and `aria-atomic` all `null`, and every SSE message was written to the DOM twice (the
  old code assigned `innerHTML` then `textContent`; the mutation log shows each text twice).
- **Root cause:** `updateQueueDisplayForEvent` created a bare `div` with no live-region semantics.
- **Fix:** new `client/src/ui/status-line.js` (`ensureLiveStatusLine`, `setLiveStatusText`); the line is a
  `role="status" aria-live="polite" aria-atomic="true"` region. It writes only when the text changes (no
  re-announce of an identical SSE message), a brand-new region is attached empty and filled ~50 ms later
  (a region must exist before its content changes to be announced), and the latest write wins. The
  once-a-second countdown is a different element and is not a live region. Side effect: server text is now
  set with `textContent` only (the old `innerHTML` of `update.message` was an injection point).
  Call site `client/src/ui/autobook.js` `updateQueueDisplayForEvent`.
- **Tests:** `client/src/ui/status-line.test.js` (4). **After, same browser run:** attrs
  `role=status aria-live=polite aria-atomic=true`; mutation log has each status once
  (`Attempting preferred slot 11...`, `Successfully booked slot 11!`), none for the countdown. Service
  worker, CacheStorage, IndexedDB and localStorage for the localhost origins cleared and the tab closed.
- **Noticed, not fixed:** `statusCache` in `autobook.js` is written but never read, so a queue re-render
  drops the status line; and a burst of statuses within ~50 ms (planning then attempting) only announces the
  last.
