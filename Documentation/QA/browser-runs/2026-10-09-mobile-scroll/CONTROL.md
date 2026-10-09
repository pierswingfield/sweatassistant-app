# Mobile scrolling change: control evidence

Date: 2026-10-09. Local checkout: `/Users/pierswingfield/.codex/worktrees/85d2/App`.

## Basis

Original CSS set `overscroll-behavior:none` on `html, body`, suppressing native boundary bounce. Mobile content used document scrolling while the bottom navigation remained fixed over the document's momentum surface. The `haltScrollMomentum` hooks only rewrote the current scroll offsets, which does not cancel momentum. The PTR handler also prevented default at the document edge and skipped moving its scroller, interfering with native mobile rubber-banding.

## Change and checks

Mobile app content now scrolls in `.app-body`, with fixed header and nav outside that scroll surface. Native vertical overscroll is allowed; global scrollbar indicators are hidden. Mobile PTR observes pull distance without preventing native edge movement; desktop PTR retains its custom transform. Collapse, timetable anchors, and modal scroll lock now target `.app-body`.

- `npm run test --prefix client -- src/ui/pulltorefresh.test.js src/ui/modal-nav.test.js`: PASS, 2 files / 12 tests.
- `npm run test:client`: PASS, 73 files / 556 tests (run after scroll architecture change; before addition of the standalone PTR test file).
- `npm run build:client`: PASS, 83 modules transformed; existing mixed-import and chunk-size warnings.
- `git diff --check`: PASS (exit 0).
- `npm test` (Node 20.19.0, local dummy encryption key): PASS, 81/81 server suites and 74/74 client files / 559 tests; exit 0.

## Browser limits

Real Chrome extension tab: local app `http://localhost:5173/timetable`, tab ID `547342576` (Chrome extension browser 1, session `01a11d44-45bb-7dd2-a743-2c35598004a2` may refer to the pre-existing session; confirm tab ownership before reuse). Content wheel-scroll visibly changed timetable rows. Nav taps via CUA did not register, so nav interaction is inconclusive. Original dev site `https://sweat-dev.wingfield.tech/timetable?f=all` likewise did not reproduce iOS touch inertia; desktop Chrome is not an iOS device. Native iOS bounce, pull-to-refresh success/failure reset, and first-tap-during-momentum remain unverified on iPhone/iPad.

## Real Chrome browser verification (2026-10-09)

Used the local mock app at `http://localhost:5173` in the user's Chrome extension browser, 503 px wide. The visible viewport is narrow/mobile-layout sized; interactions here use desktop mouse input.

- Timetable wheel-scroll moved class rows while credits/header area, date rail, filter rail, and bottom navigation remained visible. No scrollbar track/thumb appeared in the screenshots.
- From the scrolled timetable, clicking Home changed the URL to `/` and rendered Home; clicking Timetable returned to `/timetable`.
- Directional date heading behavior: at the top, the heading `Friday, 9 October 2026` is absent; while scrolling down it stays absent; scrolling upward partway brings it back above the date rail. The date and filter rails stay pinned.
- Filters opened. Collapsing the expanded Locations section removed its location checkboxes and changed the control to `Locations All` / collapsed.
- Settings content scrolled to reveal the lower Your Gyms and Account rows; the bottom navigation stayed fixed and no scrollbar appeared.
- First Quick Book opened the preferred-spots full-screen modal (no booking was submitted). Closing it returned to the timetable at the same lower-class position, with Ride 60, Yoga 60, and Recovery 30 rows still in view.
- A mouse drag across the date rail did not move it; a drag across bottom navigation left Timetable active. These are not touch-drag checks. CUA exposes mouse scrolling/click/drag only here, so horizontal touch inertia, pull-to-refresh, and native iOS boundary bounce remain unverified. Desktop-wide viewport was unavailable in this narrow Chrome window; iOS Safari/PWA remains unverified.
- Home opened with partially unstyled widget content in the screenshot (plain text/default button/link appearance) after navigation; the shared header and bottom navigation remained styled. This appears separate from the scroll interaction and is recorded for follow-up.

## Follow-up after independent browser review

- Targeted review of this change's CSS diff found no Home widget/card typography, color, or layout rules changed; Home-related style selectors are untouched. The only global selector change hides scrollbars. The mobile layout changes constrain the app shell and make `.app-body` its scrollport. The tester's plain/unstyled Home screenshot is therefore not explained by a direct Home-style edit in this diff; no change made for it pending an independent cause.
- Re-ran `npm run build:client` after all implementation and evidence edits: PASS, 83 modules transformed, built in 973ms. Existing mixed-import and >500KB chunk warnings remain.
- Re-ran `git diff --check`: PASS (exit 0).
- Independent browser tester verified nav taps after scrolling, modal scroll-offset restore, timetable header collapse/return, pinned rails, Settings scrolling, and hidden scrollbar. Native iOS momentum, bounce, and pull-to-refresh remain unverified.

## Header-gap and short-page bounce follow-up (2026-10-09)

Cause: `.app-body` begins at the viewport top and already reserves the visible header plus gap in its top padding. The mobile sticky inset counted the header a second time, creating a 61px gap on the 390x844 local viewport. Bookings and Auto-Book can fit their scrollport exactly, leaving no native overflow at either boundary.

- CSS now subtracts the expanded header reserve from the expanded sticky inset, and the complete reserve while the header is collapsed. In real Chrome at 390x844, the timetable sticky block starts at y=41 with the 41px header visible and at y=0 with it collapsed; the timetable outer body remains the scroller at 1430/844.
- Only the Bookings and Auto-Book panels receive `min-height: calc(100% + 1px)`. On Auto-Book at both 390x844 and 390x600, `.app-body` measured exactly one pixel of overflow. At 390x600, a real Chrome click from that edge switched to Bookings, whose normal longer content then had 111px of overflow. No booking/account action was triggered.
- `npm test` with Node 20.19.0: PASS, 81/81 server suites and 74/74 client files / 559 tests. `npm run build:client`: PASS, 83 modules transformed; existing mixed-import and chunk-size warnings. `git diff --check`: PASS.
- Desktop Chrome confirms scroll extent, header geometry, and navigation only. Native iOS bounce and pull-to-refresh remain device-unverified.

## Timetable content-only bounce follow-up (2026-10-09, baseline)

At 390x844 on local Chrome after commit `05b343c`, `main.app-body` had 586px scroll range while `#app-timetable-grid` had 0px. `.app-sticky-top` is a sibling of the grid inside the body, so native overscroll acts on the same surface as the pinned date/filter rails. PTR registration and `renderPreservingScroll()` also still target the body. A down-wheel reached `body.scrollTop=586`, `grid.scrollTop=0`; this confirms the active outer scroll surface. Desktop Chrome cannot show iOS elastic displacement.

## Timetable content-only bounce implementation (2026-10-09)

- `app-body.app-timetable-active` now disables its own vertical overflow, while `#app-timetable-grid` is the mobile native scrollport. The sticky/date/filter rails remain outside this element; the global document/body scroll position stays at zero. The date/filter panels remain pinned while only class rows move.
- Local Chrome at 390x844: grid range 586px, outer body `scrollTop=0`; mid-scroll header collapse moved the sticky block from y=41 to y=0 and reclaiming 41px left grid offset stable; upward scroll restored header y=0..41 and rails y=41 without a jump. Timetable-to-Bookings-to-Timetable switched scroll modes correctly.
- A Quick Book modal opened at grid offset 253, locked that grid, and restored offset 253 on close. No booking submitted. Existing focused tests cover nested PTR cancellation and horizontal drag suppression.
- Focused Vitest: 2 files / 15 tests passed. Full `npm test` (Node 20.19.0): 81/81 server suites and 74/74 client files / 562 tests passed. `npm run build:client`: PASS, 83 modules transformed; existing mixed-import and >500KB chunk warnings. `git diff --check`: PASS.
- Local desktop Chrome verifies DOM scroll ownership and layout only. iOS Safari/PWA native overscroll and real touch PTR remain unverified.
