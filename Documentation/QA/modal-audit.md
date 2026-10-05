# Modal/Dialog Audit - Complete Inventory

**Audit Date**: 2026-10-02
**Scope**: Client-side PWA UI (client/src and client/index.html)
**Methodology**: Search for `.psycle-modal`, `role="dialog"`, `aria-modal="true"`, `position:fixed` patterns across all UI modules

---

## Modal Inventory

| ID | Name | Trigger | File:Line | Built How | Type | Mobile | Close | Nested? |
|---|---|---|---|---|---|---|---|---|
| `psycle-booking-modal` | Studio Floor Plan / Spot Selector | Click "Book" / "Quick-Book" / edit Auto-Book row | timetable.js:3017 | HTML pre-built (index.html:731), shown/hidden | floor-plan | Full width, max 95vw, scrollable | Close btn, backdrop click | Yes (displays floor plan overlay) |
| `psycle-booking-modal` (reused) | Auto-Book Queue Entry Edit | Click edit icon on queued class | autobook.js:531 | Reuses HTML modal above | floor-plan | Full width, max 95vw | Close btn, backdrop click | No |
| `psycle-debug-modal` | Debug Class Diagnostics | Press Konami code (↑↑↓↓←→←→B) or debug mode + tap | index.html:770 | HTML pre-built, shown/hidden | info | Full width, max 95vw, scrollable | Close btn, backdrop click | No |
| `psycle-profile-explorer-modal` | Profile Explorer (raw API viewer) | Settings → About → (Konami edit mode) | settings.js:212, index.html:745 | HTML pre-built, populated dynamically | info | Full width, max 95vw, scrollable | Close btn, backdrop click | No |
| `psycle-gym-modal` | Link a Gym / Add Gym Account | Settings → Your Gyms → "Link a Gym" | settings.js:1577, index.html:758 | HTML pre-built, body populated by function | form | Full width, max 95vw | Close btn, backdrop click | Yes (nested: re-auth picker inside) |
| `psycle-notif-prefs-modal` | Customize Notifications | Settings → Notifications → "Customise Notifications" | settings.js:1860, index.html:787 | HTML pre-built, populated dynamically | form | Full width, max 95vw, scrollable | Close btn, backdrop click | No |
| `psycle-purchase-modal` | In-App Credit Purchase (Checkout) | Credits tab → click bundle card | credits.js:646 | `createElement` + `innerHTML`, dynamically created | checkout | Full width, max 420px (92vw on mobile) | Close btn, backdrop click | No (but contains qty stepper modal-like) |
| `psycle-overlap-modal` | Overlap Warning / Confirmation | POST /api/auto-book returns 409 OVERLAP_CONFIRM_REQUIRED | overlap-modal.js:133 | `createElement` + `innerHTML`, dynamically created | confirm | Full width, max 420px (92vw on mobile), scrollable | Cancel btn, backdrop click, Esc key, Close btn | No |
| `openOccupancyModal` | Studio Occupancy / Mini Minimap | Click occupancy pill or "View occupancy" (mobile) | timetable.js:2702 | `createElement` + `innerHTML`, dynamically created | info | Full width, max 420px (95vw on mobile) | Close btn, backdrop click | No (contains floor-plan minimap) |
| `openFavouritesModal` | Auto-Book Favourites Selector | Auto-Book tab → "♥ Auto-Book Favourites" | autobook.js:239 | `createElement` + inline styles, dynamically created | picker | Full width, max 480px (100% on mobile), max 90vh scrollable | Close btn, backdrop click | No |
| `openManageSpotMapsModal` | Manage Spot Maps / Floor Plans | Settings → General → (hidden in non-debug), or Auto-Book/Edit row | settings.js:620 | `createElement` + `innerHTML`, dynamically created | floor-plan | Full width, max 90vw, scrollable | Close btn, backdrop click | Yes (nested: per-studio floor-plan editor inside) |
| `openAccountPasswordModal` | Change Account Password | Settings → Account → "Change Password" | settings.js:1643 | `createElement` + `innerHTML`, dynamically created | form | Full width, max 420px (92vw on mobile) | Close btn, backdrop click | No |
| `fr-sheet` (Filter Rail) | Class Timetable Filters (Sheet) | Tap filter dropdown (mobile) or click "Filters" | filter-rail.js:160 | `createElement` + `innerHTML`, `.fr-sheet-overlay` wrapper | picker | Full height modal-sheet, 100% width, scrollable | Backdrop click, close method | No |
| `renderSheet` (Onboarding) | Onboarding Welcome/Login/Install/Calendar/Permissions | First run or Settings → About → "Replay Onboarding" | onboarding.js:183 | `innerHTML` template, `.psycle-onb-sheet` div | form/info | Full screen, scrollable carousel on welcome slide | Back button per sheet, or next action | Yes (carousel within, nested step flow) |
| `psycle-onb-intro` | Onboarding Intro Carousel (Welcome + Features) | Auto-shown on first run (step 0) | onboarding.js:227 | `innerHTML` template in `.psycle-onb-sheet`, carousel swipe | form | Full screen, fixed height slides in carousel | Next/Skip buttons or action buttons | Yes (carousel is internal, not nested modal) |
| `psycle-onb-features` | Onboarding Features Showcase | Onboarding step 2 | onboarding.js:777 | `innerHTML` template, multiple swipe slides | info | Full screen, carousel slides | Next/Back buttons | Yes (carousel within) |

---

## Shared Modal Helpers & Infrastructure

| Helper/Component | File:Function | Purpose |
|---|---|---|
| `renderSheet()` | onboarding.js:183 | Template renderer for onboarding sheets (intro, install, login, calendar, perms, gym links). Builds `.psycle-onb-sheet` with eyebrow/title/body/footer. |
| `openOverlapConfirmation()` | overlap-modal.js:133 (export fn) | Promise-based confirmation dialog for auto-book overlap warnings. Returns boolean (confirm or cancel). |
| `setupExplorerModalClose()` | settings.js:249 | Helper to wire close button + backdrop dismissal for profile explorer modal. |
| `.psycle-modal` | styles.css:2381 | Base modal container: `display:flex; inset:0; z-index:2000; align-items:center; justify-content:center; backdrop-filter:blur`. |
| `.psycle-modal-overlay` | styles.css:6144 | Overlay behind modal: `position:fixed; inset:0; background:color-mix(... 60% transparent)`. |
| `.psycle-modal-card` | styles.css:6128 | Modal card container: `background:var(--surface); border-radius:16px; max-width:95vw; border:1px solid var(--border-strong)`. |
| `.psycle-modal-header` | styles.css:2425 | Header with flex layout, h3/h4 title, close button row. |
| `.psycle-modal-body` | styles.css:2459 | Body with overflow-y:auto, flexible padding, form/list content. |
| `.psycle-modal-close-btn` | styles.css:2444 | Close button: `background:none; border:none; font-size:22px; cursor:pointer`. Hover state lightens. |
| `.psycle-onb-sheet` | styles.css (onboarding-specific) | Onboarding full-screen modal sheet. Fixed height, scrollable content. Used by `renderSheet()`. |
| `.fr-sheet` & `.fr-sheet-overlay` | filter-rail.js:160 & styles.css | Filter rail bottom sheet (mobile). Overlay with bottom slide-up animation. `fr-sheet` has `role="dialog" aria-modal="true"`. |

---

## Mobile Breakpoints & Responsive Patterns

| Breakpoint | Media Query | Used For |
|---|---|---|
| `@media max-width: 1100px` | Large tablet / desktop | Adjusts layout, hides desktop-only elements. |
| `@media max-width: 768px` | Tablet / medium mobile | Stacks sidebar to mobile header, adjusts modal width. |
| `@media max-width: 480px` | Small mobile (iPhone SE / 8) | Full-screen modals (100% width), bottom sheets, reduced padding. |
| No explicit breakpoint | Inline `max-width: 95vw` / `max-width: 92vw` | Most modals use percentage viewport width as a mobile fallback. |
| **Not found** | `@media (prefers-reduced-motion: reduce)` | Used for boot animation only; no modal motion preferences applied. |

---

## CSS Classes for Modals

```css
.psycle-modal             /* Base container, display:flex, position:fixed, z-index */
.psycle-modal.show        /* Opacity/visibility transition class (add after display:flex) */
.psycle-modal-content     /* Inner wrapper (rarely used, prefer -card) */
.psycle-modal-overlay     /* Backdrop, dismissible */
.psycle-modal-card        /* Card body wrapper, border-radius, background */
.psycle-modal-header      /* Title + close button row */
.psycle-modal-body        /* Content area, scrollable */
.psycle-modal-close-btn   /* Close button (×) */
.psycle-modal-close       /* Alias for close-btn (legacy) */
.psycle-onb-sheet         /* Onboarding modal sheet */
.psycle-onb-intro         /* Onboarding intro carousel variant */
.psycle-onb-features      /* Onboarding features carousel variant */
.fr-sheet                 /* Filter rail bottom sheet */
.fr-sheet-overlay         /* Filter rail overlay (parent of .fr-sheet) |
.psycle-purchase-modal    /* In-app checkout modal (extends .psycle-modal) |
.psycle-overlap-modal     /* Overlap warning modal (extends .psycle-modal) |
```

---

## Verification Summary

**Total Modals Found**: 14 unique modal patterns
**Pre-built HTML in index.html**: 5 (`psycle-booking-modal`, `psycle-debug-modal`, `psycle-profile-explorer-modal`, `psycle-gym-modal`, `psycle-notif-prefs-modal`)
**Dynamically Created**: 9 (`psycle-purchase-modal`, `psycle-overlap-modal`, `openOccupancyModal`, `openFavouritesModal`, `openManageSpotMapsModal`, `openAccountPasswordModal`, `fr-sheet`, onboarding sheets, etc.)

**Shared vs. Bespoke**:
- **Shared infrastructure**: Modal shell CSS classes (`.psycle-modal-*`), `renderSheet()` template helper
- **Bespoke patterns**: Some modals use inline `style.cssText` (autobook, settings), others use `innerHTML` (overlap, credits)

**No centralized modal manager** — each caller directly manipulates DOM or reuses HTML + `.show` class

---

## Sample Verification (5 Rows)

```bash
# Row 1: psycle-booking-modal at timetable.js:3017
grep -n "async function openBookingModal" client/src/ui/timetable.js
# ✓ Found: 3017

# Row 2: psycle-purchase-modal at credits.js:646
grep -n "function openPurchaseModal" client/src/ui/credits.js
# ✓ Found: 646

# Row 3: psycle-overlap-modal at overlap-modal.js:133
grep -n "export function confirmOverlap" client/src/ui/overlap-modal.js
# ✓ Found: 133

# Row 4: openOccupancyModal at timetable.js:2702
grep -n "async function openOccupancyModal" client/src/ui/timetable.js
# ✓ Found: 2702

# Row 5: fr-sheet at filter-rail.js:160
grep -n "sheetEl.innerHTML" client/src/ui/filter-rail.js
# ✓ Found: 163
```



---

## Final status (2026-10-02, after modal-to-fullscreen rollout, batches 1 to 5)

Rule: at `max-width: 768px` every page-type modal is a full-screen page (`ui/modal-nav.js`: history entry so hardware/iOS back closes it, scroll lock, dialog roles, focus, Esc). At 769px and above nothing changed. Verified in real Chrome at 390px, 768/769px and 1100px.

| Modal | Final mobile state | Close control |
|---|---|---|
| `psycle-booking-modal` (timetable book, Auto-Book edit, My Bookings edit-spots, Auto-Upgrade configure) | Full-screen page, sticky footer action, map fills width, discard guard on the three edit flows | X |
| `psycle-debug-modal` | Full-screen page | X |
| `psycle-profile-explorer-modal` | Full-screen page, unsaved-edit check | X |
| `psycle-gym-modal` (Link a gym, re-auth, Change Password) | Full-screen page; re-auth has Back arrow; password discard guard | X / Back |
| `psycle-notif-prefs-modal` | Full-screen page | X |
| `psycle-purchase-modal` (checkout) | Full-screen page; X hidden and back swallowed while a charge is in flight; Done on success | X |
| `openOccupancyModal` | Full-screen page | X |
| `openFavouritesModal` | Full-screen page (note: no UI entry point calls it today) | X |
| `openManageSpotMapsModal` | Full-screen page; reloads in place after a child save | X |
| Per-studio spot editor (`openStudioFloorPlanEditor`) | Full-screen child page over its parent or the booking page; discard guard | Back |
| `psycle-overlap-modal` | **Kept as a centred dialog** (deliberate); corner X hidden; own history entry, so back cancels the dialog only | Cancel / back / Esc |
| `fr-sheet` (filters) | **Kept as a bottom sheet** (deliberate); now has a history entry and scroll lock | backdrop / back / Esc |
| Onboarding (`renderSheet`, intro, features) | **Unchanged** (already full-screen) | existing |

Not converted: none. Known gaps: the iOS keyboard (`--vvh`) and edge-swipe-back could not be exercised on desktop Chrome and need a real iOS Safari/PWA check; `openFavouritesModal` is unreachable from the UI.
