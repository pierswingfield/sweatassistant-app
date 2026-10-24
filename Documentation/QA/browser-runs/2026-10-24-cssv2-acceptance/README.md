# CSSv2 Phase 6 acceptance (2026-10-24)

Real Chrome (Claude for Chrome), one tab, dev server from the CSSv2 worktree, mock login. Service worker, CacheStorage and IndexedDB cleared first. Mobile = same-origin iframe at 375/390/430 (window cannot shrink below 500); desktop = 1200px iframe scaled 0.41.

## Fixes made in this phase
1. Toast `:not()` catch-all restored (was absent from master and every CSSv2 commit; the AGENTS.md note was stale about the code). Verified: unknown variant `mystery` renders readable in light and dark.
2. Onboarding name step used retired `psycle-*` class names (unstyled native buttons); renamed to `app-*` in `ui/onboarding.js`.
3. Debug terminal (inline 420px) overflowed a phone viewport: `max-width: calc(100vw - 24px)`.
4. Keyboard focus in the booking modal landed under the sticky footer: `.app-modal-body { scroll-padding-bottom }`.
5. Switch knob was dark grey when on (light): `var(--on-accent-fill)`.
6. 200% text: Home widget title overlapped its action; mobile card time overlapped gym chip. Both fixed.
7. Contrast: Filters "Show classes" (dark, 3.3:1), Cancel button (3.7), discipline tags (3.0), Credits kind label (4.47) all now pass.

## Results
| Check | Result |
|---|---|
| Toast catch-all, unknown variant, light + dark | PASS |
| Invariants: `[hidden]`, `.app-table` max-width 100%, container overflow hidden + 16px radius, Status `112px !important` rule, table-cell !important rules, modal-nav.js unchanged vs master | PASS (see note 1) |
| Home, Timetable cards, date carousel, filter sheet, booking modal + spot map, Bookings, Auto-Book, Credits, Settings, full-screen modal, login, toasts, offline banner at 390 light | PASS |
| Same at 390 dark (Home, Timetable, Bookings, Auto-Book, Credits, Settings, filter sheet, login, toasts) | PASS |
| 375 and 430, light and dark: no horizontal page scroll on any tab | PASS |
| Desktop 1200 light + dark: timetable, settings; 0/10 status pill vs button overlaps | PASS |
| Focus ring visible (2px clay) via keyboard Tab in modal; bottom nav focus is the same global rule | PASS |
| 200% text, Timetable + Settings + Home | PASS after fixes; bottom nav labels ellipsize (open, note 2) |
| Contrast scan of every visible text node, all 6 tabs, light + dark | PASS after fixes (one 4.50 borderline: active settings item) |
| Glass fallback (opaque `--glass-solid`, no backdrop-filter) | PASS |
| Console errors during tab sweep | PASS (none) |
| Baseline comparison: no functional element missing vs baseline screenshots | PASS |

Notes: (1) At 1200px the Status cell measures 91px, not 112px, because auto table layout squeezes it; the layout matches the baseline screenshot and nothing overlaps. (2) At 200% the 56px bottom nav truncates labels ("Time...") by design; no overlap.

## CSS size
styles.css: master 10,462 lines / 393,510 B / 1,074 `!important` -> now 11,145 lines / 445,899 B / 875. Built CSS 300,474 B (47.3 kB gzip). Baseline (Phase 1) counted 1,055 `!important` with a postcss parse; the grep counts above use the same method on both sides.
