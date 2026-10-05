# Mobile modals to full-screen pages: spec

Scope: viewport <= 768px only (`@media (max-width: 768px)`; JS gate `matchMedia('(max-width: 768px)')`). Desktop is unchanged. Input: `modal-audit.md`, plus source spot-checks (2026-10-02).

## 0. Findings that shape the design

- The audit lists 14 rows but the real surface is a handful of **shells reused by many flows**:
  - `#psycle-booking-modal` (index.html) is reused by FOUR flows: timetable book (`timetable.js` ~3029), Auto-Book edit (`autobook.js` ~531), My Bookings edit-spots (`bookings.js` ~491) and Auto-Upgrade configure (`bookings.js` ~924). The audit missed the last two.
  - `#psycle-gym-modal` (`settings.js gymModal()` ~1170) is reused by Link Gym, re-auth and Change Password (`openAccountPasswordModal`).
  - `timetable.js` `openOccupancyModal` and `settings.js` `openManageSpotMapsModal` build `.psycle-modal` + `.psycle-modal-card/-content` + `.psycle-modal-header/-body` by hand.
- Two incompatible card classes exist: `.psycle-modal-card` (styles.css ~6128, `width:520px; max-width:90vw; max-height:85vh`, plus a `!important` 95vw/90vh rule at ~4800 inside the mobile block) and `.psycle-modal-content` (~2404, `width:960px; max-width:95vw; max-height:90vh`). Several pre-built modals carry inline `style="max-width:..; width:.."`. These inline styles lose to `!important` only.
- `.psycle-modal` is `position:fixed; z-index:2000000; height:100lvh` (not `dvh`, so it ignores the iOS keyboard and dynamic toolbar), toggled by `style.display='flex'` + `.show` after 10 ms, closed by `.show` removal + 300 ms `display:none`.
- There is NO history handling (`pushState`/`popstate` grep is empty), NO scroll lock, NO focus trap, NO `role="dialog"`/`aria-modal` (except `.fr-sheet`), and Escape is handled only by the overlap modal. iOS swipe-back and Android back currently leave the PWA view behind the modal.
- `.fr-sheet-overlay` (z-index 10050) sits below `.psycle-modal` (2000000), so a modal opened from the filter sheet would cover it.
- Source of truth for stylesheet rules: `styles.css` only. It has 637 `!important`s, and source order beats ties (AGENTS.md), so new mobile rules must go AFTER the base modal rules (~6190) and use `!important` where they fight inline styles.

## (a) Per-modal decision

Rule for the close control:
- **X (top-right)**: terminal, self-contained task started from a tab. Dismissing returns to where you were. No parent page inside the overlay.
- **Back arrow (top-left)**: drill-down, i.e. a page reached from another overlay/page that the user returns to (nested), or a multi-step flow. The arrow returns to the parent, not to the tab.
- Rule of thumb: if after closing you land in another overlay, use back. If you land on the tab, use X.

Dialog vs page: stay a small centred dialog if it is a short decision with <= ~3 lines of copy and <= 2 buttons and no scrolling content. Everything with scroll, form fields, maps or lists becomes a page.

| Modal | Mobile decision | Control | Notes / justification |
|---|---|---|---|
| Booking / spot selector (`#psycle-booking-modal`, timetable) | **Full-screen page** | X | Floor plan needs the width and height. Primary action ("Book N spots") in sticky footer. |
| Auto-Book queue edit (same shell) | Full-screen page | X | Same shell; footer = Save. |
| My Bookings edit-spots (same shell, `bookings.js` ~491) | Full-screen page | X | Same shell; footer = Save/Swap. |
| Auto-Upgrade configure (same shell, `bookings.js` ~924) | Full-screen page | X | Same shell. |
| Debug diagnostics (`#psycle-debug-modal`) | Full-screen page | X | Long raw text, debug-only. No footer. |
| Profile Explorer | Full-screen page | X | Large raw JSON tree; edit mode has an unsaved-changes check (`settings.js` ~292), which must run on close (see section b8). |
| Gym modal: Link a gym | Full-screen page | X | Form with credentials; keyboard-heavy. |
| Gym modal: re-auth picker inside link flow | Same page, step 2 | Back (to step 1) | Replace body content, push a history entry so swipe-back returns to the list. |
| Gym modal: Change Account Password | Full-screen page | X | Form. Currently shares the shell with link-gym; treated as its own task (own title, own footer). |
| Notification prefs | Full-screen page | X | Long list of toggles/dropdowns; changes are saved per control (toast on error), so no dirty state. |
| Credit purchase / checkout (`.psycle-purchase-modal`) | Full-screen page | X on step 1, none during in-flight charge | See section (c). |
| Overlap warning (`.psycle-overlap-modal`) | **Keep dialog** | none (two buttons) | Short destructive/confirm choice, Promise-based (`openOverlapConfirmation`), has Esc. Becomes full-width bottom-anchored alert is NOT needed: keep centred card, drop the redundant X on mobile. |
| Occupancy minimap (`openOccupancyModal`) | Full-screen page | X | Contains a floor-plan minimap; read-only. Could be a half-height bottom sheet but a page is simpler and consistent. |
| Auto-Book Favourites (`openFavouritesModal`) | Full-screen page | X, footer Save if it persists on Save | Long list (profile bookmarks). Check whether it saves per tap or on button; match footer to that. |
| Manage Spot Maps (`openManageSpotMapsModal`) | Full-screen page (parent) | X | List of studios. Drill-down into per-studio editor below. |
| Per-studio floor-plan editor (`openStudioFloorPlanEditor`, `settings.js` ~938) | Full-screen page (child) | **Back** | Nested: from Manage Spot Maps and also from the booking page's "configure" link. Dirty-state guard. |
| Filter rail sheet (`fr-sheet`) | **Keep as bottom sheet** | existing close/backdrop | Already a purpose-built mobile sheet with `role="dialog"`; wiring it into the shared history/scroll-lock helper is enough. Not part of the full-screen change. Out of scope for batches 1-4, in batch 5 only for history + scroll lock. |
| Onboarding sheets (`renderSheet`, intro, features) | **No change** | existing | Already full-screen pages with their own back/next flow. Intro/features are carousels inside a page, not modals. Do not wrap with the shared helper. |

Net: 12 modal surfaces become pages, 1 stays a dialog (overlap), 1 stays a bottom sheet (filters), onboarding untouched.

## (b) One shared mobile pattern

Single contract for every page-modal below 768px.

1. **Shell**: `.psycle-modal` becomes `position:fixed; inset:0; height:100dvh; display:flex; flex-direction:column; align-items:stretch; background:var(--bg)`; no blur, no overlay (hide `.psycle-modal-overlay`). The card (`.psycle-modal-card` and `.psycle-modal-content`) becomes `width:100% !important; max-width:none !important; height:100%; max-height:none !important; border:0; border-radius:0; box-shadow:none; animation:none`. This one rule set overrides the inline `max-width/width` styles in index.html and the inline `width:420px; max-width:92vw` in `credits.js`.
2. **Header** (`.psycle-modal-header`): `position:sticky/flex-shrink:0; min-height:52px; padding: calc(env(safe-area-inset-top) + 8px) calc(16px + env(safe-area-inset-right)) 8px calc(16px + env(safe-area-inset-left))`. Centred serif title (`--font-serif` per DESIGN.md), single-line ellipsis. Control sits left for back, right for X. Hit target >= 44x44px (`.psycle-modal-close-btn` currently has 4px padding; raise on mobile). Drop the hover rotate. The X glyph stays the existing `&times;` button, so the markup is unchanged; back is the same button with a modifier (`data-nav="back"`) that CSS re-renders as a left chevron and moves to the left via `order`.
3. **Body** (`.psycle-modal-body`): `flex:1; min-height:0; overflow-y:auto; -webkit-overflow-scrolling:touch; overscroll-behavior:contain; max-height:none; padding: 12px 16px 16px`, and `padding-bottom: calc(16px + env(safe-area-inset-bottom))` when there is no footer.
4. **Sticky footer for the primary action**: add an optional `.psycle-modal-footer` as the last child of the card (`flex-shrink:0; padding: 10px 16px calc(10px + env(safe-area-inset-bottom)); border-top; background:var(--surface)`). Modals that render their primary button inside the body (floor plan Save, Book, Purchase, password submit) should get it moved into the footer by the helper's optional `footer` slot, OR, for the cheap path, CSS-only: mark the existing primary row with `.psycle-modal-actions` and make it `position:sticky; bottom:0` inside the scrolling body with the same safe-area padding. Prefer the sticky-in-body approach for batches 1-3 (zero markup change) and move to a real footer only where needed.
5. **Keyboard**: `100dvh` plus `interactive-widget=resizes-content` is not honoured by iOS Safari, so: in `modal-nav.js` listen to `visualViewport` `resize` and set `--vvh` on the shell; the shell uses `height: var(--vvh, 100dvh)`. On `focusin` of an input, `scrollIntoView({block:'center'})` after 250 ms. Footer stays visible above the keyboard because the shell shrinks to the visual viewport. Inputs must be >= 16px font to prevent iOS zoom (check `.psycle-input` on mobile).
6. **Accessibility**: shell gets `role="dialog" aria-modal="true" aria-labelledby=<title id>` (alert dialogs: `role="alertdialog"`). On open: remember `document.activeElement`, move focus to the title (tabindex -1) or the first field for forms. Trap Tab within the shell (simple first/last sentinel loop). Set `inert` (fallback `aria-hidden`) on `#psycle-app root`/sibling containers while open. On close: restore focus. Escape closes the topmost page (same code path as back). Respect `prefers-reduced-motion` (disable the slide).
7. **History / hardware back / iOS swipe-back**: each open page does `history.pushState({ sweatNav: id, depth }, '')`. A single `popstate` handler closes the topmost page. Closing via X/back button calls `history.back()` (so the stack stays consistent) and the popstate handler does the actual teardown; programmatic close after a successful save also goes through `history.back()`. Nested pages push their own entry, so one swipe-back/hardware back pops exactly one level. Guard against the existing hash router: check what `main.js` tab routing does with the URL (the memory note says hash-route reloads are special); use `pushState` with the SAME URL (no hash change) so tab routing is not disturbed. If an entry is no longer top when closing programmatically (the user already navigated), skip `history.back()`.
8. **Dirty guard**: the helper accepts `canClose()` returning true/false (or a Promise). On popstate with a dirty page, re-push the entry immediately (`history.pushState`) to cancel the pop, then show the small confirm dialog "Discard changes?" (reusing the overlap-modal visual style). Used by: floor-plan editor (selection differs from saved), Profile Explorer edit mode, change password form with any typed value, checkout is handled separately (see c3).
9. **Scroll lock**: on first open, `document.body.style.position='fixed'; top=-scrollY; width:100%` (iOS Safari ignores `overflow:hidden` on body) and add class `psycle-scroll-locked`; on last close restore and `scrollTo(scrollY)`. Counter-based so nested pages do not unlock early. Inner scroll uses `overscroll-behavior:contain`.
10. **Animation**: page enters with `transform: translateX(100%) -> 0` for drill-down (back) pages and `translateY(100%) -> 0` for X pages, 220 ms `cubic-bezier(0.25, 1, 0.5, 1)`, opacity-only under reduced motion. Replace the existing 10 ms `.show` + 300 ms `display:none` timers with the helper only where a modal is touched; the CSS keeps the existing `.show` contract so untouched call sites still work.
11. **Z-order**: nested pages stack by DOM order within one `z-index` (do not mint new z-index values). The filter sheet and toasts: toasts must be above pages (verify `.psycle-toast` z-index > 2000000 or raise it), since save/error toasts fire from inside pages.
12. **iOS standalone**: top header needs `viewport-fit=cover` (check `index.html` meta; the bottom nav already uses `env(safe-area-inset-bottom)`, so it is likely present). Status-bar colour follows `main.js` ~149 logic; page background `var(--bg)` keeps it consistent.

## (c) Special cases

### 1. Nested flows
- **Rule**: one open page at a time visible; parent stays in the DOM beneath (hidden by `inert`/covered), so scroll position and state survive. Each level pushes a history entry (b7). Child uses Back; parent keeps X.
- **Manage Spot Maps -> studio editor**: child page opened via `openStudioFloorPlanEditor`; on save it calls `onSaved` then pops itself, leaving the list page refreshed.
- **Booking page -> "configure" link** (`timetable.js` ~3578): today it closes the booking modal synchronously (`display:none`) and opens the editor, which loses the user's in-progress spot selection and, after save, leaves the user on the timetable. On mobile: keep the booking page open beneath, open the editor as a back-arrow child, and on return the booking page re-resolves prefs via the existing `resolveStudioPrefs(event)`. That removes the "transition race" comment's workaround. Behaviour change; acceptance test in batch 3.
- **Gym modal link -> re-auth picker**: step-in-page with Back to step 1 (b7: push entry per step).
- **Opening from the filter sheet**: close the filter sheet first (no stacking with `fr-sheet`).
- Depth cap 2 (page -> child). Nothing in the audit needs 3.

### 2. Floor-plan editor (spotmap.js, booking, edit-spots, upgrade configure)
- The map is pixel-scaled from `.psycle-floor-scroll` width (`spotmap.js`), measured at render time. On a page the container becomes full width, so the map must **render after the page is visible and laid out** (after the entry animation's first frame, or measure on `transitionend`/`ResizeObserver`), otherwise it measures 0 or the old width. Add a `ResizeObserver` re-fit on `visualViewport` resize and orientation change.
- Existing rule at styles.css ~2608 (`.psycle-modal-body .psycle-floor-scroll`) already goes edge-to-edge on mobile; keep it, and give the scroll area `touch-action: pan-x pan-y` so pan does not fight the page's vertical scroll or iOS back-swipe. Test that dragging the map does not trigger edge-swipe back (edge swipe starts <= ~20px from the left; keep 16px side padding on the map container so the first touch lands inside).
- Selection state is local to the editor until `onSave`; it is the dirty source for the guard (b8).
- Primary action (Save / Book) in the sticky footer; the secondary "Any spot" button (`#spot-save-any`) is a text link above it.
- Two renderers exist (spotmap.js pixel vs `openBookingModal` %-based, per memory). The page shell is shared; do not unify renderers in this change.

### 3. Checkout (credits purchase)
- Page with X. Dismissal is **blocked while a charge is in flight** (hide X, ignore popstate by re-pushing the entry; show the existing spinner state), because backing out of an off-session charge leaves the user unsure whether they paid. After `requires_action` the code uses `window.open` to the website (credits.js ~825); the PWA page remains open with the tips and a Done/Close. Never auto-close on success: show the success state with a footer "Done" button.
- Two-step (init -> confirm): the Back/X rule stays X; step 2 is in-page content, not a nested page, so no extra history entry. Dirty guard not needed before the charge, but add a "Cancel purchase?" confirm only if the cart is already created server-side (check; init adds the bundle to a cart, so a stale cart line can remain; confirm what the existing X does today and keep that behaviour).
- Qty stepper (audit says modal-like) is inline in-page, not a layer. Confirm in code during batch 5; if it is an overlay, convert to an inline control.
- No real purchases in testing (live-testing authorisation): acceptance test uses the dev mock and stops before confirm.

### 4. Overlap warning (kept as dialog)
- On mobile: remove the corner X (Cancel is already a button), keep backdrop tap and Esc/back as cancel. Because it can be triggered from a page-modal (auto-book edit), it must stack above pages and participate in the history stack (push on open, pop on close) so a hardware back cancels the dialog rather than the page behind it.

## (d) Implementation approach (minimal per-modal change)

1. **CSS-only core** in a single block appended after ~6190 of `styles.css`:
   `@media (max-width: 768px) { .psycle-modal:not(.psycle-overlap-modal) { ... } .psycle-modal:not(.psycle-overlap-modal) .psycle-modal-card, ...-content { ... } ... }`. It restyles every existing shell via the existing class names, overrides inline widths with `!important`, and leaves desktop and the overlap dialog untouched. Optional exclusions by id are not needed.
2. **One small helper `client/src/ui/modal-nav.js`** (~120 lines) exporting `registerPage(el, { id, canClose, onClose, back: false })` / `openPage(el)` / `closePage(el)` and a global `popstate` handler. It does nothing when `matchMedia('(max-width: 768px)')` is false, so desktop behaviour is byte-for-byte as before. Responsibilities: history push/pop, scroll lock (counter), `inert` on background, focus capture/restore/trap, `role/aria-*` attributes, `--vvh` keyboard variable, Esc.
3. **Per-modal change = a one-line call** where it currently does `modal.style.display='flex'; setTimeout(()=>modal.classList.add('show'),10)` and its close function: replace with `openPage(modal, {...})` / `closePage(modal)`. The helper keeps the old `.show` and `display:none` contract on desktop, so the call sites can be edited one batch at a time without breaking desktop. Pre-built modals register once at boot (they are in index.html); dynamic ones (`credits.js`, `settings.js`, `timetable.js` occupancy) register on creation.
4. **Back variant**: add `data-nav="back"` to the close button in the child pages (floor-plan editor, gym step 2); CSS renders the chevron. No new buttons.
5. **Do not** convert inline `style.cssText` modals wholesale; the `!important` mobile block handles them. Only touch inline widths if a verified conflict appears.
6. **Tests**: `modal-nav.test.js` (vitest + jsdom is fine for the stack/counter logic: open/close nesting, popstate order, dirty guard, scroll-lock counter, no-op on desktop width). Real layout is browser-verified, per `TESTING.md` and AGENT_PROTOCOL (real Chrome, CDP :9222 or Claude for Chrome, one tab; jsdom is NOT enough for layout).
7. **Risks**: 637 `!important` collisions (mitigate: block placed last, verify with computed styles); hash-router interplay with `pushState`; iOS keyboard inside a fixed element (verify on a real iOS Safari/standalone PWA, since desktop Chrome at 390px does not emulate the iOS keyboard or edge-swipe); service worker cache (per prod deploy cache gotcha: hard-clear SW, CacheStorage and IndexedDB when verifying CSS changes).

## (e) Rollout: 5 batches, each independently shippable and testable

All tests: real Chrome, window resized to 390x844, dev mock account (`dev@psycle.com`), plus 1100px regression for desktop. Record evidence under `QA/browser-runs/`.

**Batch 1: Shared CSS shell + helper + simple read-only pages** (Debug, Profile Explorer, Notification prefs, Occupancy).
- Add the CSS block and `modal-nav.js` (+ unit tests). Wire only these four.
- Acceptance at 390px: each opens edge-to-edge (card rect = 0,0,390,844; `getBoundingClientRect` width = innerWidth, no horizontal scroll); header respects the safe-area padding (computed `padding-top` >= 8px, with `env()` supported); body scrolls and the header stays put; X hit area >= 44px; browser Back (or `history.back()`) closes it and the underlying tab is intact; `document.body` is scroll-locked while open and restored after (scrollY preserved); Esc closes. At 1100px: all four still render as centred cards (width <= 960px) with the overlay. `npm test` green.

**Batch 2: Form pages** (Gym link, re-auth step, Change Password, Favourites).
- Acceptance: Link Gym opens full-screen; focusing the email field keeps the field and the primary button visible (field's rect fully inside `visualViewport`); the re-auth step shows a Back arrow, and history Back returns to step 1 first, then a second Back closes; Change Password with a typed value shows "Discard changes?" on Back and the page stays open until confirmed; focus returns to the opener on close; Tab stays trapped inside; `role="dialog"` and `aria-modal` present.

**Batch 3: Booking shell and floor-plan flows** (timetable book, Auto-Book edit, edit-spots, upgrade configure).
- Acceptance: for each of the four entry points the page opens full-screen with the map scaled to the full width (`.psycle-floor` width >= 358px, no horizontal overflow, slot taps still register); Book/Save is a sticky footer visible without scrolling and above the iOS home indicator (bottom padding includes the inset); selecting spots then history Back with a changed selection triggers the discard guard on the edit pages; the "configure" link opens the editor as a child with a Back arrow and returning shows the booking page with the selection intact (regression of the old close-then-open); no Console errors.

**Batch 4: Spot-map management + nesting** (Manage Spot Maps parent, per-studio editor child).
- Acceptance: parent list full-screen with X; tapping a studio opens the child with a Back arrow; save refreshes the parent list and pops the child only (one history entry consumed); hardware/browser Back from the child lands on the parent, from the parent on the tab; drag-panning the map does not trigger swipe-back and does not scroll the page behind; unsaved selection triggers the guard.

**Batch 5: Checkout, overlap dialog, filter sheet, polish.**
- Credits purchase page: X present before confirm, X hidden and popstate re-pushed while a charge is in flight (use the mock / stop before the real confirm; no real purchases), success shows a Done button, `requires_action` falls back to the website path without closing the page.
- Overlap dialog: remains a centred dialog at 390px, opens above a page-modal (open it from Auto-Book edit on a conflicting class), history Back cancels the dialog only, the page beneath stays.
- Filter sheet: hardware Back closes the sheet, body scroll-locked while open.
- Global polish: toasts above pages (`z-index` check), reduced-motion check, 768px and 769px boundary check (769px = centred modal, 768px = page), no `display:none` timer races (rapid open/close 5x leaves no stuck overlay or orphaned history entries; `history.length` delta is 0 after open+close).

Out of scope: onboarding (already full-screen), unifying the two floor-plan renderers, moving the legacy inline styles to classes (tracked under U3).

## Open decisions for the owner

1. Overlap dialog: keep as a centred card (spec default) or promote to a bottom sheet for thumb reach?
2. Favourites: confirm whether it saves per tap or on a Save button (determines footer).
3. Checkout: does the existing X today clear a created server-side cart line? The spec preserves current behaviour pending a code check.
4. Is `viewport-fit=cover` already in `index.html`? (Batch 1 prerequisite; one-line check.)
