# CSSv2 Phase 1 baseline (2026-10-24)

Branch `CSSv2`, worktree `App-CSSv2`, no CSS changed. Evidence: `QA/browser-runs/2026-10-24-cssv2-baseline/`.

## 1. Capture sources and method

| Folder | Source | Role |
|---|---|---|
| `sweat-dev/` | https://sweat-dev.wingfield.tech (current master, the signed-in account already in the Chrome tab, real data: 3 gyms Aarmy/JAB/Psycle, real bookings and waitlists) | **Primary.** Read-only: tab switching, opening one swipe-reveal row, nothing saved. |
| `localhost-mock/` | This worktree, `npm run dev`, throwaway DB, dev mock gyms (Psycle + JAB) | Secondary reference (mock data); has the booking modal and spot map |
| `landing/` | `landing/index.html` served statically on :8099 ("Dibs", formerly Front Row) | Landing reference |

- Real Chrome via Claude for Chrome, one tab. `resize_window` does not change the page viewport in this setup (innerWidth stayed 955/1200), so **mobile widths are emulated by loading the app in a same-origin iframe of exactly 390 / 375 / 430 px** (media queries and layout respond to the iframe width; touch input, iOS safe-area insets and OS chrome are NOT emulated). Desktop captures are the real viewport (955 px on sweat-dev, 1200 px on localhost), not 1280.
- Theme was switched by setting `data-theme` on `<html>` (DOM only, no setting saved).
- Files: `<width>-<theme>-<screen>.png|jpg`. Mobile 390 light+dark: home, timetable, bookings, (autobook, settings menu on sweat-dev light; all on localhost both themes); 375 and 430 light: home, timetable. Desktop both themes: home, timetable, bookings, auto-book, settings (account), gym section (JAB).
- **Not captured**: Credits tab (hidden unless `debugMode`, `main.js` creditsTabAllowed; enabling it would save a setting, so not done on sweat-dev), onboarding (completed flag), full-screen mobile modal pages on sweat-dev (booking, edit-spots, filters sheet) - only the localhost desktop booking modal and spot-prefs intro exist (`localhost-mock/1200-dark-modal-*`). Offline, error and reduced-motion states, keyboard and text-zoom passes, installed-iOS PWA safe-area checks: not done (need a device). Home "Booked Classes" shows "Couldn't load this" on the mock (mock bookings are dated July); not a CSS defect.
- Side effects to know: on localhost a first tap on Cancel armed a double-click confirm (not confirmed); on sweat-dev one scripted click toggled a local `ab-rail-toggle` row and Edit opened the swipe-reveal row (screenshot `390-dark-bookings-swipe-reveal-cancel.png`). No network write was intended or issued by me.

## 2. Screen / state inventory (observed)

Home (date strip, Booked Classes, Credits and passes per gym, Find a class, Your activity, trending instructors, favourites); Timetable (date carousel, gym chips + search + Filters rail, rows with Book / Quick Book / Join Waitlist / Leave WL / Buy Credits / BOOKED + Edit/Cancel, "..." menu, mobile card layout vs desktop table); My Bookings (cards per gym, waitlisted pill, swipe-reveal Cancel, Share); Auto-Book (banner "Nothing queued", queue empty state, collapsible History); Settings (mobile = list menu, desktop = sidebar; Account, per-gym section with Connection / Spot Maps / Membership / Booking window / Auto-Upgrade / Profile Explorer); modals: spot-prefs intro, booking spot map, cancel-confirm toast. Gym states seen: metered (Psycle credits), membership (JAB), unmetered with 0 credits (Aarmy), waitlisted, booked, buy-credits.

## 3. CSS metrics (`client/src/styles.css`, postcss parse, script reproducible)

| Metric | Value |
|---|---|
| Lines / bytes | 10,463 / 391 KB |
| Rules / declarations | 2,011 / 7,754 |
| `!important` | **1,055** (13.6% of declarations) |
| Selectors with an ID (`#app-helper-container` anchor etc.) | 995 of 2,362 comma-parts; 115 with 2+ IDs |
| Highest specificity | (3 IDs, 5 classes) `#app-helper-container #app-panel-home > #app-home-widgets > .home-desktop-column > .home-w...` L10393; next: L9183 timetable-active (3,2,0), L8170 `.app-spot-upgrade-chip:not(...)` (2,5,0) |
| Duplicate (media + selector) preludes | 162 selectors, 240 extra copies. Worst: `@media 768 #app-helper-container .app-sticky-top` 9x (+5x outside), `:root` 7x (15 `:root*` blocks incl. theme variants), `.app-mobile-seg.primary` 7x, `.app-filters-card` 6x, `.app-bottom-nav-btn.active` 5x |
| `@media (max-width: 768px)` blocks | 95 (17 distinct media queries) |
| Custom property declarations | 257 |
| `@keyframes` | 16 |
| Distinct literal colours outside tokens | 71 hex + 21 rgba() strings (18 distinct when counted only in non-token declarations by the stricter script) |
| Distinct literal `font-size` values | 40 (7px to 38px, em/rem/clamp mixes); 293 `font-size: Npx` declarations vs 96 `var()` |
| Distinct literal border-radius values | 23 |
| Distinct durations | 23 (0.12s to 28s; 12 under 1s: 0.12, 0.15, 0.18, 0.2, 0.22, 0.25, 0.26, 0.3, 0.35, 0.4, 0.6, 0.8) |

Inline `style="..."` occurrences in JS (static strings) / `.style.x` writes: timetable.js 185/141, settings.js 110/63, credits.js 55/5, bookings.js 52/39, onboarding.js 38/15, tooltips.js 27/9, main.js 9/49, spotmap.js 8/49, favourites-pane.js 8/0, cards.js 8/0, calendar-section.js 7/1, autobook.js 4/5, gym-settings-section.js 4/2, filter-rail.js 2/5, pulltorefresh.js 1/31, loading-skeleton.js 1, autoupgrade.js 1. JS total ~510 static `style="` plus `client/index.html` 166.

Versus the 2026-10-06 audit: lines 11,452 -> 10,463, `!important` 1,108 -> 1,055, rules 2,088 -> 2,011, mobile 768px blocks 77 -> 95 (grew). The prefix is now `app-`/`#app-helper-container` (old `psycle-` names gone).

## 4. Landing tokens (`landing/index.html`, brand "Dibs", light only, no dark mode)

- Colours: bg `#f5f2ec`, surface `#fbfaf7`, text `#1f1b16` / secondary `#6b6358` / tertiary `#938a7c`, accent clay `#c9785c` (hover `#b5694e`), slate `#6f8aab`, success `#059669`, violet `#7c5cdb`, warning `#c2870a`; plates Psycle `#212121`, JAB `#6c1f20`, Aarmy `#000`.
- Fonts: Fraunces 500/600 (serif, all h1-h4, brand, big time numerals) + Inter 400/500/600; scale 12/14/16/18 px.
- Radii: card 20px, control 12px, pills 999px; also 14/9/6 px one-offs. `--tap-min: 44px`.
- Glass recipe: `background rgba(255,255,255,.62)` (strong .82 fallback), `1px solid rgba(255,255,255,.85)` plus `1px` inset outline `rgba(31,27,22,.10)`, `blur(18px) saturate(1.25)`, shadow `0 4px 12px rgba(31,27,22,.08)`, sheet `0 18px 48px rgba(31,27,22,.12)`; `@supports not backdrop-filter` -> strong opaque.
- Motion: `--spring: cubic-bezier(.25,1,.5,1)`, 0.2 to 0.35s.

## 5. Facts later phases must not regress

Desktop and shared (from code, verified in the live app where noted):
1. `[hidden] { display: none !important }` at `styles.css:17` (inline `display` otherwise beats the UA rule).
2. Timetable Status column `width: 112px !important` (L5036); `.app-table { max-width: 100% }`; `.app-table-container` needs `overflow: hidden` with its radius.
3. Every modal is a full-screen page on mobile via `modal-nav.js` markup contract (`.app-ovl*`).
4. Table-cell and settings-menu rules need `!important` and source order after the base rule (documented gotcha).
5. Capability-gated markup: Credits tab gated on `debugMode`; unknown capability defaults ON.

Mobile (measured on sweat-dev through 390/375/430 iframes; identical at all three widths):
6. No horizontal page overflow: `documentElement.scrollWidth` equals viewport on Home, Timetable, Bookings, Auto-Book, Settings. Home has off-screen carousel children (`home-favourite-card` right edge 600px at 390 and 375) which are scrollers, not page overflow; keep it that way.
7. Bottom nav: `.app-bottom-nav` position fixed, height 56px, buttons 55px tall, `padding-bottom` computed 0px in a desktop browser (safe-area is applied through `env(safe-area-inset-bottom)` rules, 25 stylesheet rules contain `safe-area-inset`; value only visible on a notched device), background `rgba(244,242,236,.6)` + `blur(15px) saturate(1.9)`. Header 41px tall, 8px top padding. Viewport meta: `viewport-fit=cover, maximum-scale=1, user-scalable=no`; `theme-color` `#ebeae4`.
8. Timetable mobile card: `.app-mobile-class-card` 390x100 (row `td` 390x111); main block 213x76; time 16px, class name 15px/500 Inter, primary button `.app-mobile-seg.primary` 91x40, 12px text, radius 8px.
9. Tap targets under 44px (visible interactive elements, count per screen: Home 6, Timetable 31, Bookings 12, Auto-Book 4, Settings 4): `app-header-gym-badge` 61-70x24; `app-mobile-seg` 91x40 (16 on Timetable); filter chips `fr-chip-body` 30px tall, `fr-chip-x` 20x30, `fr-gymquick-btn` 28x28, `fr-trigger` 32x32; `ab-rail-toggle` 57x28; `ab-spot-upgrade-chip` 62-67x23-28; `bk-guest-chip` 28x28; `app-share-btn` 84x36; `home-favourite-cta` 102x36; `app-modal-close-btn` 22x32; the "..." row menu.
10. Inputs/selects/textareas with computed font-size under 16px (iOS zoom on focus): none found on the five main screens at rest (body is 14px; the timetable search field was not focused/measured separately; inputs inside modals not measured).
11. Body font 14px Inter; Fraunces is applied by the blanket heading rule (class names in cards stay Inter).

## 6. Phase 3 result (2026-10-24, U3-2 cascade and `!important` cleanup)

Measured with the same postcss script on `client/src/styles.css` (Phase 2 commit vs Phase 3):

| Metric | Phase 2 | Phase 3 |
|---|---|---|
| Lines / rules | 10,540 / 2,021 | 10,526 / 1,879 |
| `!important` | 1,056 | 847 (-20%; the 25% aim was not reached safely) |
| Duplicate (media + selector) preludes | 163 | 93 (8 are the intentional `:root` token/theme blocks) |
| `@media (max-width: 768px)` blocks | 95 | 32 |
| `.app-sticky-top` mobile rules | 9 | 2 |
| `backdrop-filter` declarations | 44 | 2 (bottom nav `--glass-blur`, plus its `@supports` fallback) |
| `font-family: var(--font-serif)` | 19 | 4 (type-role block + brand wordmark role) |

Method (all cascade-preserving): a rule or declaration only moves or loses `!important` when no other declaration of the same property family, at equal importance and equal specificity, could sit between the old and new place (class co-occurrence taken from the rendered DOM). `!important` was dropped only where a computed-style test in the real DOM (390/375/430/1200, light and dark, all main tabs, filter sheet, booking and spot-map modal, settings sections, login, onboarding, offline, search) showed no change, no inline style on the element, no hover/focus competitor that would then win, no animation targeting the property, and no unseen competitor that could match the same element, and no second `!important` rule of the same family that could hit the same elements (two such rules mask each other in a one-at-a-time test; the first run of this pass broke the active bottom-nav colour that way and the equivalence run caught it). Declarations in families JS also writes inline (display, transform, opacity, transition, position, max-height, z-index) were left alone, as were `[hidden]`, the toast `:not()` catch-all, the Status column width and reduced-motion rules.

Equivalence: 132 rendered states (8 viewport/theme blocks) compared by computed style and layout against the Phase 2 stylesheet. Only the intended differences remain: removed `backdrop-filter`, and opaque backgrounds on the offline banner, waitlist jump bar, toast and pull indicator. Remaining differences are async-data noise (a favourite heart or home widget loaded in one run and not the other), also present between two runs of the unchanged CSS.

Deleted with evidence (class token absent from `client/src`, `index.html`, `public`): `.fav-buy-btn`, `.grid-label`, `.warning-dismiss-btn`, `.debug-section-title`, `.debug-label`, `.bk-upgrade-btn`, `.home-empty-action`, `.home-credits-list/row/gym`, `.home-stat-tile/number/label`, `.home-attendance-label`, `.home-autobook-copy`; keyframes `pulse-ring`, `backdropFadeIn`, `fadeInMs`, `app-pulse-confirm` (referenced nowhere). `.t-card-title` and `.t-caption` are token-layer roles and were kept.

Not done / debt for Phase 4: physical re-ordering into sections (the file is banner-labelled, not reshuffled, because source order is the cascade), the 847 remaining `!important` (mostly beating `#app-helper-container` specificity and inline styles), the 93 duplicate preludes blocked by genuine ordering conflicts, presentational inline styles in JS, and unseen states (hover/focus variants of important rules, rarely rendered UI) which were kept conservatively.
