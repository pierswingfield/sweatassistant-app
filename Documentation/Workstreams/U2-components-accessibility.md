# U2 — Shared components and accessibility

**Priority:** P2 · **Size:** ~2–3 days · **Depends on:** nothing (best after C4) · **Blocks:** U3 in part

> **Verify first:** before changing anything for an item, confirm its basis in the code **and**, for anything user-visible, **in a real browser** (CDP :9222 or Claude for Chrome). For server-only items, use a failing test or a request. Record the evidence. If a browser check is needed and no browser is available, stop with `BLOCKED`. See [AGENT_PROTOCOL.md](AGENT_PROTOCOL.md).

Consolidate duplicated UI into shared components first. Accessibility then gets fixed once,
instead of in every copy.

| # | Item | Evidence (verified 2026-09-26) | Depends on | Est. |
|---|---|---|---|---|
| U2-1 | ✅ **DONE (verified 2026-10-06, delivered by U5-3 archived).** `client/src/ui/modal-nav.js` (`openPage`/`closePage`/`pushLayer`) owns open, close, Esc, backdrop, scroll-lock and history for pages; `overlap-modal.js` keeps its own DOM but registers via `pushLayer`. **Shared `openModal()` shell.** Modals are handled two ways today: static `.psycle-modal` elements and ad-hoc overlay divs. One shell should own open, close, Esc, backdrop and scroll-lock. [B3] | `client/src/main.js` ~L1373–1416 | — | 1 day |
| U2-2 | ✅ **DONE (verified 2026-10-06, U5-3 archived).** `modal-nav.js` traps Tab in the top page (lines ~94-101), makes background `inert`, and returns focus to the opener on close (~144); `overlap-modal.js` does the same itself. **Modal focus trap and focus return.** (Original note, now stale: "No focus-trap code exists anywhere.") `:focus-visible` styles do exist. [A3] | — | U2-1 | 2 h |
| U2-3 | ✅ *pulled forward into launch 2026-09-28, done* **`aria-live` on auto-book status updates.** Toasts have it; the SSE status line in the Auto-Book tab doesn't, so screen readers miss "Booked!". [A1] | `client/src/ui/autobook.js` ~L129–153 | — | 30 min |
| U2-4 | **STILL OPEN (verified 2026-10-06: empty states are still hand-rolled in bookings.js, autobook.js, autoupgrade.js, credits.js, settings.js with `psycle-empty-state` / `fav-empty-state` + inline styles).** **Shared `renderEmptyState()`.** Auto-Book, Bookings, Credits and Auto-Upgrade each hand-roll their own empty state. [B2] | No shared helper in `cards.js` | — | 2–3 h |
| U2-5 | ✅ **IMPLEMENTED (mobile filter rail + sheet, `1676f01`; refined through 5-10 items 7, 9, 12, Q2).** Not re-audited line by line against the brief; do that before closing. **Implement `TIMETABLE_FILTER_DESIGN_BRIEF.md`** (timetable filter redesign). Added 2026-09-27 at the user's request. Brief: [`TIMETABLE_FILTER_DESIGN_BRIEF.md`](../TIMETABLE_FILTER_DESIGN_BRIEF.md). It covers the mobile filter bar, the active-criteria chips and the filter bottom sheet, and nothing else. Size this item from the brief before starting. Filters are gym-grouped and must stay per-gym correct (see AGENTS.md: `psycleDefaultFilters` has no bare-key fallback; string ids via `sameId()`). Do it after C4, because it changes the timetable, the main acceptance screen. | `client/src/ui/timetable.js` filters | C4 | TBD from brief |
| U2-6 | ✅ *done 2026-09-29* **Desktop timetable stickiness.** Keep the timetable's filter bar and date selector sticky on desktop, but allow the page header/title block above them to scroll normally. | U2-5 desktop browser validation | U2-5 | 1–2 h |
| U2-7 | ✅ *done 2026-09-29* **Contextual filter-sheet navigation.** Clicking an active timetable filter pill should open the filter sheet with the corresponding section automatically scrolled into view and unrelated sections collapsed. | U2-5 filter rail/sheet | U2-5 | 1–2 h |

Design reference: [`DESIGN.md`](../DESIGN.md). Original audit:
[`Archive/…/ui-ux-sweep.md`](../Archive/2026-09-26/Backlog/ui-ux-sweep.md).

## Next UX follow-ups

- **U2-6:** On desktop, only the timetable filter and date-selector bars should remain sticky; the timetable header/title should scroll away.
- **U2-7:** Clicking a timetable filter pill should open the filter sheet at its relevant section, with other sections collapsed.
- **Filter Sheet Animation (U4-15):** The filter bottom sheet should animate in with a smooth slide-up transition from the bottom edge (`translateY(100%)` → `translateY(0)`), with matching exit animation on dismiss.

## U2-6 / U2-7 — DONE 2026-09-29

- **U2-6 basis:** `.psycle-tab-header` sat inside `.psycle-sticky-top`, so the title pinned with the filters. **Fix:** header moved out of the wrapper in `client/index.html`. **Evidence (real Chrome, mock, 1182px):** after `.psycle-body` scrolled 400px the header bottom was -221 (gone) while the wrapper stayed pinned at the body top (100) and still contained the filter card and date carousel.
- **U2-7 basis:** every rail chip called `openSheet(ctx)` with no section, and the sheet kept whatever `openSecs` held. **Fix:** `filter-rail.js` chips carry `data-fr-section` (gyms→locations, eventTypes→workouts, instructors→instructors); `openSheet(ctx, key)` collapses the rest, opens that section (plus the instructor gym groups holding picks) and scrolls it to the top. The filter trigger button keeps the previous state. **Evidence (real Chrome, 400px same-origin iframe, mock):** each chip opened with only its own section in `.fr-sec.open`; the Instructors chip scrolled the sheet body to its max (82px) with the section and the picked instructor visible.
- Note: `api-credits-by-gym.test.js` fails in vitest (`localStorage` undefined) with and without this change; not from this work.

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
