# CSSv2 spinner audit (2026-10-25)

Rule applied: a spinner stays only where it shows an in-flight ACTION or a background refresh of content that is already on screen. Anything that stands in for content that has not arrived yet (lists, cards, panels, floor plans) is a skeleton (`client/src/ui/loading-skeleton.js`: `renderFloorPlanSkeleton`, `renderPanelSkeleton`, `renderCardSkeletons`; static under `prefers-reduced-motion`).

Scope: every `.app-spinner`, `@keyframes` rotation, and inline SVG spinner under `client/`. Result: 15 replaced, 8 kept (one of which, the header gym arc, is a per-gym network indicator that was made more prominent).

| Location | Result | Why |
|---|---|---|
| `bookings.js` Edit-spots modal (floor map load) | Replaced: floor-plan skeleton | Content placeholder |
| `bookings.js` Auto-Upgrade configure modal (floor map fetch) | Replaced: floor-plan skeleton | Content placeholder |
| `spot-setup.js` spot-setup editor step (layout fetch) | Replaced: floor-plan skeleton | Content placeholder |
| `timetable.js` booking modal (layout / availability check) | Replaced: floor-plan skeleton | Content placeholder (the spot-map selection screen) |
| `timetable.js` Studio Occupancy modal | Replaced: floor-plan skeleton | Content placeholder |
| `tooltips.js` occupancy tooltip (inline SVG spinner) | Replaced: compact floor-plan skeleton (3 rows) | Content placeholder |
| `settings.js` Spot Maps: floor plan editor | Replaced: floor-plan skeleton | Content placeholder |
| `settings.js` Spot Maps: studio list | Replaced: card skeletons | List placeholder |
| `settings.js` Profile Explorer | Replaced: panel skeleton | Content placeholder |
| `timetable.js` Book-a-guest eligibility check | Replaced: panel skeleton | Content placeholder |
| `timetable.js` debug modal body | Replaced: panel skeleton | Content placeholder |
| `index.html` debug modal initial body | Replaced: panel skeleton (static markup) | Content placeholder |
| `index.html` timetable grid initial body | Replaced: card skeletons (static markup) | List placeholder; JS swaps in the timetable skeleton on render |
| `credits.js` bundle list | Replaced: card skeletons | List placeholder |
| `credits.js` checkout step 2, saved cards | Replaced: panel skeleton | Content placeholder |
| `credits.js` checkout "Processing payment" | Kept: spinner | In-flight ACTION (pay); the user must not interact |
| `pulltorefresh.js` pull indicator | Kept: spinner | In-flight refresh gesture feedback |
| `index.html` Active Bookings / Waitlists "Refreshing" chips (`.app-refreshing-chip`) | Kept: small inline spinner | Background revalidation of content already painted |
| `styles.css` `.app-tab-refresh-btn.refreshing` (`tab-refresh-spin`) | Kept: rotating glyph | Button action in flight |
| `styles.css` `.app-native-btn .app-spinner` | Kept: inline button spinner | Button action in flight (book, save) |
| `index.html` `html:not(.app-ready)::after` boot ring (`app-boot-spin`) | Kept: spinner | App boot, before any layout or tokens exist to build a skeleton from |
| `styles.css` `.app-header-gym-badge.is-loading::after` (`hgb-spin`) | Kept: arc, made ~20% more prominent | Per-gym network-activity indicator, not a content placeholder |
| `settings.js` Profile Explorer save button ("Saving…") | Kept: text on a disabled button | Action in flight; no spinner element |

Dead CSS removed: `.tip-spinner-svg`. `.app-spinner`, `.app-loading-spinner-container` and `.set-loading-*` remain because kept sites and the pull indicator use them.

## Gym badge animation (task 4)

`.app-header-gym-badge.is-loading::after` (toggled by `gym-load-state.js` only while that gym has a page-content request in flight; not ambient). No scale or glow exists, so the 1.2x applies to the three visible properties.

| Property | Before | After |
|---|---|---|
| ring opacity | 0.6 | 0.72 |
| arc colour alpha | 55% | 66% |
| ring thickness | 1px | 1.2px |
| duration | 1.6s | 1.6s (unchanged) |
| reduced motion (static ring) opacity | 0.2 | 0.24 |

## Nav clearance with the floating glass nav (task 5)

Measured at 390 wide, `?nav=glass`, dark theme, scrolled to the end with a 1400px filler as the last item in each panel (the mock account has too little data to overflow). Gap = nav top minus last item bottom; positive means nothing hides under the bar.

| Page | Gap |
|---|---|
| Bookings | 86px |
| Auto-Book | 50px |
| Credits (tab is behind the TEMP `debugMode` gate; reached via popstate) | 50px |
| Settings | 30px |

No page hides its last item, so no CSS change was needed. Settings has the tightest gap.
