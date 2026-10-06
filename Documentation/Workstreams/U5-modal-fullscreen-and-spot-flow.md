# U5 — Mobile full-screen pages and the spot-map booking flow

**Priority:** P2 · **Depends on:** nothing hard · **Blocks:** nothing

> **Verify first:** see [AGENT_PROTOCOL.md](AGENT_PROTOCOL.md). Everything here is user-visible: check at 390px and at a desktop width in real Chrome (CDP :9222), and iOS-specific behaviour on a device. Desktop (above 768px) must stay unchanged.

Started 2026-10-02 from the user's iPhone feedback that modals were cramped and left the app showing behind them. Mobile (`max-width: 768px`) modals became full-screen pages with browser/iOS Back support. The user confirmed on device (iOS 27) that **swipe-back works**.

Related documents: [QA/modal-audit.md](../QA/modal-audit.md) (inventory, with final status), [QA/modal-to-fullscreen-spec.md](../QA/modal-to-fullscreen-spec.md), [QA/spotmap-booking-flow-spec.md](../QA/spotmap-booking-flow-spec.md). **F-17** (instructor-change notification) was added separately in [F-future-features.md](F-future-features.md) and is not part of U5.

## A. Progress (done)

| # | Item | Status | Files | Acceptance evidence |
|---|---|---|---|---|
| U5-1 | **Modal inventory audit.** | ✅ DONE 2026-10-02 | `Documentation/QA/modal-audit.md` | 14 modal patterns listed; final-status table added after the rollout (every modal is a page, or deliberately kept). |
| U5-2 | **UX spec: modals to full-screen pages.** Page vs dialog rules, X vs Back, shared shell, 5 rollout batches. | ✅ DONE 2026-10-02 | `Documentation/QA/modal-to-fullscreen-spec.md` | Reviewed by the coordinator; each batch below was verified against its acceptance section. |
| U5-3 | **Batch 1: shared shell.** `.psycle-page` CSS plus `modal-nav.js` (history entry per page, scroll lock, dialog roles, focus, Esc, safe-area). Wired to Debug, Profile Explorer, Notification prefs, Occupancy. | ✅ DONE | `client/src/ui/modal-nav.js`, `modal-nav.test.js`, `styles.css`, `settings.js`, `timetable.js`, `main.js` | 390px: edge-to-edge, 44px X, Back and Esc close, body scroll-locked and restored; 1100px unchanged; `npm test` green. |
| U5-4 | **Batch 2: gym modal and Change Password.** Link gym, re-auth (Back arrow), password (discard guard), Favourites page. | ✅ DONE | `settings.js`, `autobook.js`, `modal-nav.js`, `styles.css` | Field inside the visual viewport, Tab trapped, focus returned, discard prompt on Back. |
| U5-5 | **Batch 3: booking shell and spot editor.** Timetable book, Auto-Book edit, edit-spots, Auto-Upgrade configure as pages; sticky footer; map fills the width; spot editor as a Back-arrow child. | ✅ DONE | `timetable.js`, `autobook.js`, `bookings.js`, `settings.js`, `spotmap.js`, `styles.css`, `copy.js` | Map width at least 358px, no horizontal overflow, selection survives the editor child, discard guard on the edit flows. |
| U5-6 | **Batch 4: Spot Maps manager and nesting.** Manager page (X), per-studio editor child (Back), in-place reload after save, pan contained to the map. | ✅ DONE | `settings.js`, `styles.css` | History depth 2 for the child; save pops only the child; Back from parent lands on the tab. |
| U5-7 | **Batch 5: checkout, overlap dialog, filter sheet.** Checkout page (X hidden and Back swallowed while a charge is in flight, mock only); overlap stays a centred dialog with its own history layer; filter sheet gets history and scroll lock. | ✅ DONE | `credits.js`, `overlap-modal.js`, `filter-rail.js`, `modal-nav.js` (`pushLayer`), `styles.css`, `QA/modal-audit.md` | In-flight Back and Esc swallowed; `requires_action` keeps the page; overlap Back cancels the dialog only; 768px is a page, 769px a card. |
| U5-8 | **Batch A polish (2026-10-05 device feedback).** Double scrollbar (html locked, app hidden, no inner scrollers); fixed-bottom Close footers on info pages; re-auth/link form top-aligned with gym logo; pages pinned to the visual viewport for the iOS keyboard; full gym logos in Settings panes and Your Gyms; Spot Maps picker with logos and 44px targets. | ✅ DONE (keyboard unverified on device, see B1) | `modal-nav.js`, `cards.js` (`gymLogoBanner`), `settings.js`, `gym-settings-section.js`, `styles.css` | Final regression at 390px across 22 pages: full-bleed, Esc and Back restore scroll and app, no behind-scrollers, one scroller per page; keyboard simulated by stubbing `visualViewport`. |
| U5-9 | **Spot-map booking flow, batch 1.** Identity strip (gym logo, location, studio), static page titles, "This class" card, dismissible persisted helper. | ✅ DONE 2026-10-05 | `client/src/ui/booking-chrome.js` (new), `timetable.js`, `autobook.js`, `bookings.js`, `spotmap.js`, `copy.js`, `styles.css` | Four flows at 390px: no class text in the title, card within 10px of the map, helper dismissal persists across reload and survives blocked storage. |
| U5-10 | **Spot-map booking flow, batch 2: Step A setup.** One-time per-studio setup page (intro, editor, saved confirmation) then Step B; stepper; replace-history semantics; Auto-Upgrade "needs spots" row; save-failure state. | ✅ IMPLEMENTED 2026-10-05 | `client/src/ui/spot-setup.js`, `modal-nav.js`, `timetable.js`, `spotmap.js`, `booking-chrome.js`, `copy.js`, `styles.css` | Save failure stays on the editor. The follow-up U5 feedback adds Back from A0 and lets Back from B return to A2. Automated suites/build pass; no browser UI check was run. |
| U5-11 | **Spot-map booking flow, batch 3: mode variants.** Auto-Book release countdown and copy; compact FCFS Auto-Book page; simple-book setup banner; offline and re-login guards. | ✅ DONE 2026-10-05 | `booking-chrome.js`, `timetable.js`, `copy.js`, `styles.css` | Countdown "Opens in 6d 17h"; FCFS schedule created a queue entry (mock, then deleted); offline and relogin disable the buttons with a reason and clear. `npm test` green (60 server suites, 286 client tests). |

## B. Open items already known

| # | Item | Notes |
|---|---|---|
| U5-12 | **Real-iOS keyboard check.** Confirm on a device that tapping an input shows no app behind or around the keyboard accessory bar (pages are pinned to the visual viewport). | Needs a device; the iOS Simulator tool needs a full Xcode install. Only simulated in Chrome so far. |
| U5-13 | **`openFavouritesModal` has no UI caller.** ✅ DONE 2026-10-05 | Removed the exported dead page, its private bookmark helpers, and unused copy. Root cause confirmed 2026-10-05: source search found only the exported definition and related helper/copy references; the local mock's Auto-Book page exposes the queue but no Favourites action, while the scheduler does not consume this setting. Acceptance: source search is clean; real Chrome at 390px and 1100px shows Auto-Book queue with no Favourites action; `npm test` passes (60 server suites, 287 client tests). |
| U5-14 | **Dev mock returns empty prefs after a spot-map save.** The save toast succeeds but `GET /api/studio-preferences` returned `{}` for the gym in tests, so row labels never flip to "Edit Spots". | Investigate the mock or the prefs cache (`withOfflineSnapshot`). The client works around it by trusting the saved payload. |
| U5-15 | **Gym re-auth has no step 1.** The spec's "Back returns to step 1 first" cannot happen, because re-auth opens straight from a gym row. | Spec acceptance was changed to "one Back closes it". Update the spec text. |

## C. Follow-up feedback (implemented 2026-10-05)

| # | Item | Notes |
|---|---|---|
| U5-16 | **Quick-Book / Auto-Book setup navigation.** | ✅ IMPLEMENTED | `spot-setup.js`, `timetable.js`, `modal-nav.js`, `spotmap-booking-flow-spec.md` | A0 has Back. Continue replaces A2 with B, so completing or leaving the booking flow cannot reveal the saved confirmation again. The class-flow alternative is **Choose a spot for now**; it bypasses saved-map setup and keeps selections class-specific. |
| U5-17 | **Setup text hierarchy, shared entry, and “work out” wording.** | ✅ IMPLEMENTED | `spot-setup.js`, `copy.js`, `settings.js`, onboarding via Spot Maps manager, `styles.css` | Reworked intro hierarchy and updated the headline. Mobile onboarding and Settings open the shared setup/editor page for per-studio map edits. |
| U5-18 | **Helper spacing and row-specific guidance.** | ✅ IMPLEMENTED | `copy.js`, `spot-setup.js`, `spotmap.js`, `styles.css`, `timetable.js` | Uses the requested spot-selection copy. Whole-row guidance appears only when row preferences are enabled and the map has multiple rows. Reduced the helper-to-map gap. |
| U5-19 | **Explain and implement “Any spot is fine.”** | ✅ IMPLEMENTED | `spot-setup.js`, `timetable.js`, `copy.js`, `spot-setup.test.js` | Clears the saved studio map. Quick-Book and Auto-Book can proceed with any available spot; Auto-Upgrade remains unavailable without preferences. “Choose a spot for now” instead uses class-only choices and does not save the studio map. |
| U5-20 | **Simplify final “Book your spot” step.** | ✅ IMPLEMENTED | `timetable.js`, `styles.css`, `copy.js` | Removed duplicate studio-map banner and edit hint in setup flow, hid the repeated selection summary, and reduced the control panel treatment. The class card and visible map provide the context. |
| U5-21 | **Quick-Book completion and deleted-map cache regression.** | ✅ FIXED 2026-10-05 | `spot-setup.js`, `timetable.js`, `studio-preferences-state.js`, `api.js`, `cache.js`, `server.js`, `db.js` | Continue replaces the saved page; Quick-Book has no “Edit preferred spots” button; successful preference deletion clears the server row, IndexedDB responses/snapshots, and live timetable aliases. Opaque studio IDs are preserved. Focused regressions and full automated checks pass. |
| U5-22 | **Quick-Book candidate, duplicate and attendee-limit handling.** | ✅ IMPLEMENTED 2026-10-06 | `timetable.js`, `booking-attempts.js`, `booking-limits.js`, `api.js`, `copy.js`, `marianatek.js`, `routes-normalized.js` | Step B is titled “Finish Quick-Book”; its chosen candidate is identified with app-name-aware copy. JAB self/guest eligibility is now account-and-class scoped from MarianaTek class state plus payment options: one primary self reservation, and a distinct single-guest flow with a guest email and pass check. Quantity selectors render only when the current self entitlement exceeds one; existing provider rules remain unchanged. Extra self bookings funded by ordinary credits and multiple guests remain deliberately unimplemented pending a confirmed provider contract. |

**Verification:** `npm test` passed (60 server suites, 302 client tests); `npm run build:client` passed with existing Vite chunk-size/import warnings; `git diff --check` passed. No browser or computer-control check was run; U5-12 remains the device-only keyboard check. U5-14 (mock preference reload) and U5-15 (re-auth spec wording) remain open.

## D. Commit summary and handoff

This section is the staging ledger for the work completed during the 2026-10-05/06 implementation thread. It is intentionally descriptive: it does not replace the Git history and does not authorize committing unrelated working-tree changes.

### Completed commits and deployments

| Commit | Scope / handoff meaning | Deployment state |
|---|---|---|
| `c47519c` | U5 spot/modal feedback: setup Back navigation, shared Settings/onboarding entry, conditional row guidance, copy hierarchy, and simplified final setup step. | Superseded by later U5 commits. |
| `0386e2d` | Initial Home dashboard development. | Included in the later dev tree; keep separate when staging. |
| `dfc4dcb` | Remaining bugfixes and enhancements unrelated to the initial Home dashboard. | Included in the later dev tree; keep separate when staging. |
| `f0ab68e` | Deployment records for the grouped work above. | Dev deployment record; production untouched. |
| `63938db` | Spot-flow copy cleanup and deployment follow-up. | Deployed to sweat-dev. |
| `5d730df` | Registry deployment note. This commit accidentally included pre-existing registry edits from the separate skills repository; nothing was deleted or reverted. | Do not rewrite history without explicit direction. |
| `da7522a` | Booking timeout/duplicate handling, JAB attendee-limit handling, selected-candidate overlay, and related tests/docs. | Deployed to sweat-dev. |
| `aa80cd1` | No-map Quick-Book entry behavior, full-map chosen-spot overlay, and MarianaTek Ground/Bag section normalization and G/B presentation labels. | Deployed to sweat-dev. |
| `9e599a0` | Entitlement/guest v1: provider-based self/guest options, single guest entry points, no selector at one eligible self booking, and `Finish Quick-Book`. | Deployed to sweat-dev. |
| `58807f2` | Guest live spot selection, self/guest/full ownership states, grouped guest cancellation safety, guest chips, `Guest` menu label, and plus icon. | Deployed to sweat-dev. |

### Decisions and evidence to preserve

- MarianaTek exposes separate `user_payment_options` and `guest_payment_options`; JAB live reads showed `guest_usage_limit=2` and `guest_remaining_usage_count=2`. The account’s self quota fields and ordinary credit balances were null/expired in the tested account.
- A controlled self-booking probe on event `82530` (Friday 09 October 2026, 08:10 London, George Davies) returned HTTP 201 for the first self reservation and HTTP 422 for the duplicate self attempt. The reservation was subsequently cancelled by the user. No class inside the 48-hour safety window was touched.
- `is_penalty_cancel` / `isPenalty` predicts a cancellation fee; it does not mean cancellation is forbidden or that usage will be lost. The frontend should use the provider cancellation-preview endpoint rather than deriving fee state only from a 12-hour heuristic.
- Extra self bookings funded by ordinary credits remain unimplemented pending a provider capture from an account with live usable credits. Multiple guests in one action also remain deferred. Do not infer either behavior from class capacity or guest-pass allowance.
- MarianaTek supplies `spot_type.name` such as Ground and Bag. G/B prefixes are JAB presentation policy: display `G 24` / `B 13` in textual labels, chips, bookings, history, and queues, while retaining bare numerals on the visual map.
- Browser verification was performed only through raw CDP on isolated tabs; no computer-use tool was used. Live booking/cancellation mutations were not used for UI verification.
- The shared workspace has repeatedly contained unrelated dirty Home/settings/filter/CSS/docs changes. Preserve them; stage only the requested U5 hunks. The final-round agents for cancellation-modal and edit-map eligibility work later hit the account usage limit before producing a verified commit.

### Final-round work still to stage

1. **Grouped cancellation modal:** when a class has multiple booked spots, the existing Cancel action must open a modal immediately (no old confirmation step). List every self/guest spot, provide an individual cancel action and a Cancel all action, require a separate confirmation tap for each action, update the modal after each cancellation, close on explicit dismissal or when the last spot is gone, and retain the single-booking confirmation flow for one spot. Guest cancellations must run before primary cancellation; failures must leave the primary and remaining guest state intact.
2. **Guest copy verification:** confirm the My Bookings/timetable action reads exactly `Guest` and uses the plus icon; remove any lingering `Book Guest` copy.
3. **Edit-map eligibility enforcement:** the booked-class Edit modal must use normalized entitlement and prevent over-selection in the UI, client request validation, and server route. It must account for self versus guest ownership, stale state, provider limits, and other-gym rules without restoring a global JAB hard cap.
4. **Verification and release:** run focused tests for modal trigger/confirmation/order/failure/auto-close and edit-map exact-limit/over-limit behavior; run the full Node 20 suite/build/diff check; perform a raw-CDP non-mutating recheck; stage only these changes; deploy the exact clean commit to sweat-dev; update the registry/CHANGELOG narrowly; leave production untouched.
