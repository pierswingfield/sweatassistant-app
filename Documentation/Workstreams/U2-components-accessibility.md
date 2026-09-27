# U2 — Shared components and accessibility

**Priority:** P2 · **Size:** ~2–3 days · **Depends on:** nothing (best after C4) · **Blocks:** U3 in part

> **Verify first:** before changing anything for an item, confirm its basis in the code **and**, for anything user-visible, **in a real browser** (CDP :9222 or Claude for Chrome). For server-only items, use a failing test or a request. Record the evidence. If a browser check is needed and no browser is available, stop with `BLOCKED`. See [AGENT_PROTOCOL.md](AGENT_PROTOCOL.md).

Consolidate duplicated UI into shared components first. Accessibility then gets fixed once,
instead of in every copy.

| # | Item | Evidence (verified 2026-09-26) | Depends on | Est. |
|---|---|---|---|---|
| U2-1 | **Shared `openModal()` shell.** Modals are handled two ways today: static `.psycle-modal` elements and ad-hoc overlay divs. One shell should own open, close, Esc, backdrop and scroll-lock. [B3] | `client/src/main.js` ~L1373–1416 | — | 1 day |
| U2-2 | **Modal focus trap and focus return.** No focus-trap code exists anywhere. `:focus-visible` styles do exist. [A3] | — | U2-1 | 2 h |
| U2-3 | **`aria-live` on auto-book status updates.** Toasts have it; the SSE status line in the Auto-Book tab doesn't, so screen readers miss "Booked!". [A1] | `client/src/ui/autobook.js` ~L129–153 | — | 30 min |
| U2-4 | **Shared `renderEmptyState()`.** Auto-Book, Bookings, Credits and Auto-Upgrade each hand-roll their own empty state. [B2] | No shared helper in `cards.js` | — | 2–3 h |
| U2-5 | **Implement `TIMETABLE_FILTER_DESIGN_BRIEF.md`** (timetable filter redesign). Added 2026-09-27 at the user's request. **The brief is not in the repo yet**: add it at `Documentation/TIMETABLE_FILTER_DESIGN_BRIEF.md` and link it here before starting, then size this item from it. Filters are gym-grouped and must stay per-gym correct (see AGENTS.md: `psycleDefaultFilters` has no bare-key fallback; string ids via `sameId()`). Do it after C4, because it changes the timetable, the main acceptance screen. | Brief not yet in repo; `client/src/ui/timetable.js` filters | Brief added; C4 | TBD from brief |

Design reference: [`DESIGN.md`](../DESIGN.md). Original audit:
[`Archive/…/ui-ux-sweep.md`](../Archive/2026-09-26/Backlog/ui-ux-sweep.md).
