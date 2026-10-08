# CSS debt audit (read-only)

Date: 2026-10-06. Scope: `client/src/styles.css` (11,452 lines, the only stylesheet; `index.html:70`), `client/index.html`, `client/src/**/*.js` (non-test).
Method: a comment-stripping brace parser (node, scratch scripts, not committed) plus grep. Counts are parser counts unless marked grep. Prefix renames (`psycle-`) are out of scope (see naming audit, category C, U3-1); overlaps are noted only.

## Headline

The Workstream U3 numbers are stale: the file grew from ~7,300 to 11,452 lines and every debt metric grew with it.

| Metric | U3 doc (2026-09-26) | Now |
|---|---|---|
| `!important` declarations | 637 | **1,108** (grep: 987 lines / 1,127 tokens) |
| Inline `style="..."` attrs (JS + html) | 474 (ui only) | **690** (525 in JS, 165 in index.html), plus 399 `.style.x =` and 51 `style.cssText` |
| Hard-coded `font-size: Npx` | 203 | **358** (vs 78 `var()`) |
| Rules | n/a | 2,088 rules, 7,988 declarations |

`panel-layout.css` does not exist in the tree (`git ls-files | grep css` returns only `styles.css`; no code references). Only stale prose remains: `Documentation/DESIGN.md:216-218`, the archived `Documentation/Archive/2026-10-08/U3-css-design-debt.md`, and comments at `styles.css:8738,8740`.

## 1. `!important`

- 648 of 1,108 (58%) sit in rules whose selector starts with `#psycle-helper-container`. An ID selector already beats any class rule, so these are not fighting specificity. They exist to (a) beat earlier `!important` rules (an arms race: later layers must also use it) and (b) beat inline `style=""` strings that JS emits. Honest split: (a) dominates; (b) is provable only for the `[style*=...]` attribute selectors (6 rules, `styles.css:6017,6025,6108,6115,10136`).
- 462 (42%) are inside `@media` blocks (mostly `max-width: 768px`, the mobile "page" layer).
- Selector family: `.psycle-*` 843 of the rules' first class, `.ab-*` 66, `.badge*` 24, `.fr-*` 21, `.event*` 17.
- Properties: background 114, color 99, display 83, padding 64, border 63, width 51, font-size 49, height 37, border-radius 30, box-shadow 25.
- Density by region (per 500 lines): hot bands are 2500-4000 (~80/500, legacy dashboard/timetable), 6000-7000 (~60-75), 8000 (107), 9500-11000 (65-115, the mobile/filter-rail/gym-rail layers, newest and the worst).
- Cause chain: a single ID anchor (`#psycle-helper-container`) + one dead-code legacy layer + mobile overrides re-declaring the same selector 5-8 times (see section 3) = every layer escalates. U3-2 depends on U3-1 for this reason; confirmed.

## 2. Dead CSS

Class dead-ness: a class is "dead" when its token has no word-boundary match in `index.html`, `public/sw.js` or any non-test `client/src/**/*.js`.

- 909 distinct classes in CSS; **247 dead**, of which 12 are "uncertain" (dynamic `variant-${}`, `state-${}`, `is-${}` builders exist): `is-hidden, is-current, variant-danger-strong, variant-warning, variant-success, variant-warning-solid, variant-debug, variant-success-outline, state-failed, state-success, state-waitlist`.
- Rules whose every comma-part needs a dead class (cannot match anything): **398 rules, ~2,230 lines (~19% of the file), 197 of the `!important`s**.
- Dead families: `psycle-*` 126 (legacy dashboard: `psycle-dashboard-*`, `psycle-footer*`, `psycle-auth-overlay`, `psycle-split-*`, `psycle-native-*`, `psycle-slot-bubble`, `psycle-booking-card`, `psycle-global-refresh-btn`...), `u-*` 19 (utility classes at `styles.css:638-656`: defined to "replace inline styles" but never adopted, see section 4), `fr-*` 13 (`fr-brand*`, `fr-gymcard`, `fr-plate*`, `fr-pill` at 9513-9576), `detail-*` 11 + `grid-*`/`price-*`/`credit-*` (Buy-Credits detail view, 1829-1970), `debug-*` 7, `fav-*`/`qty-*`/`bundle-*`/`row-*` (1240-1800), `log-old/new`, `month-name`, `ab-gym-name`, `bk-upgrade-btn`.
- Dead ids: `#psycle-backdrop-blur` (:720), `#psycle-pause-autobook-btn` (:4009-4017), `#favs-modal-close` (:10979).
- One dynamic name to protect: `settings.js:1707` builds `psycle-${empty-state|card-error}`; neither is in the dead list (checked).
- Custom properties: 113 defined. Defined but unreferenced anywhere (css or js): `--auto-not-scheduled, --on-auto-not-scheduled, --buy-credits-bg, --on-buy-credits, --feat-waitlist, --space-panel, --space-filter, --gap-section, --gap-element, --pad-card`. Referenced from js only (keep): `--gym-ink-hover, --gym-pip, --feat-quickbook, --page-solid`.
- **Used but never defined** (real bugs, fall back to initial value): `--surface-hover` (1 use), `--radius-sm` (2), `--surface-3` (1), `--brand` (3), `--surface-1` (4; one use at `:11417` has a fallback). Runtime-set vars from JS (`--vvh, --vvt, --logo-w, --logo-scale, --timetable-cta-w, --skeleton-width, --psycle-header-h, --perk, --gym-settings-accent`) are not defects.
- `@keyframes`: 16 defined, **all referenced** (none to delete).

## 3. Duplicate / overridden rules

- 1,882 unique (media-context + selector) preludes vs 2,088 rules: **136 preludes defined more than once, 206 extra copies**.
- Worst: `#psycle-helper-container .psycle-sticky-top` (8x in `@media 768`, 5x outside: lines 9681-10572), `.psycle-filters-card` (6x), `.psycle-mobile-seg.primary` (6x, 10493-10740), `.psycle-bottom-nav-btn.active` (5x), `:root` (7 blocks, lines 20, 536, 2043, 7321, 10101, 10113, 11417), `:root[data-theme="light"]` (4+).
- `@media (max-width: 768px)` appears **77 times** (+ 5 combined with colour-scheme/reduced-motion); sources of the late-file mobile layers overriding one another. Other repeats: reduced-motion 13, `min-width: 769px` 7.
- Conflicting-value analysis was not run per declaration; the repeated mobile selectors above are the likely conflict set (later copy wins by order or `!important`). Needs a computed-style diff before merging.

## 4. Inline styles

- JS `style="..."`: timetable.js 183, settings.js 110, credits.js 55, bookings.js 51, onboarding.js 34, tooltips.js 27, autobook.js 25, main.js 9, cards.js 7, calendar-section.js 7, spotmap.js 6. index.html: 165 occurrences (149 lines). Only 28 contain `${}` interpolation (dynamic); ~95% are static and class-able.
- Top declaration patterns (count of occurrences): `font-size: 12px` 121; `color: var(--text-secondary)` 107; `display: flex` 102; `align-items: center` 60; `color: var(--text)` 53; `width: 100%` 51; `font-size: 13px` 49; `font-weight: 600` 43; `color: var(--text-tertiary)` 42; `display: none` 41 (22 whole-attribute `display: none;`, ripe for `hidden` attribute, which already has `[hidden]{display:none!important}`).
- Five utility classes that would remove most of it: (1) `.u-text-secondary` + `.u-xs` (12px), (2) `.u-flex-center` (`display:flex;align-items:center;gap:8px`), (3) `.u-w-full`, (4) `[hidden]` instead of `display:none`, (5) `.u-semibold` / `.u-text` (`color:var(--text);font-weight:600`, 12 whole-attr repeats). Note `u-text-secondary, u-xs, u-semibold, u-center, u-nowrap` etc. already exist at `styles.css:637-656` but are **dead**; adopt them rather than inventing new ones (the sizes may need adjusting to 12/13px).
- Inline styles are the reason ~6 `[style*=...]` selectors and part of the `!important` set exist.

## 5. Tokens and theme parity

- Hex colour values inside non-custom-property declarations: 79; `rgba()` calls: 11 (hard-coded, e.g. `rgba(31,27,22,0.38)` at 9918-9919). 200 lines match a 6-digit hex or `min-height: Npx`. Fixed colours in `:root` are fine; the 79 are the bypass.
- Font sizes: 358 literal vs 78 tokenised (U3-3).
- Theme mechanism: dark default at `:root` (line 19), light via `@media (prefers-color-scheme: light)` (9 blocks; none for dark) and forced `:root[data-theme="light"]` (14 refs) / `[data-theme="dark"]` (13 refs). Tokens are defined three times (dark 20-260, system-light 261-343, forced-light 344-425), so a new token added to one block drifts silently.
- Parity gaps to check by hand: rules written only under `:root[data-theme="light"]` with no `:root:not([data-theme="dark"])` twin (e.g. 9918-9920, 11392, 2047, 11418) do not apply when the system is light and theme is `auto`. Not enumerated exhaustively; treat as MEDIUM investigation.

## 6. Cleanup plan

### SAFE (zero visual change, provable)
1. **Delete dead rules** (398 rules, ~2,230 lines). Evidence to re-verify per class: `grep -rnw "<class>" client/index.html client/public/sw.js client/src --include='*.js' | grep -v '\.test\.js'` returns nothing, and no template builds the prefix (`grep -rn '<prefix>-\${' client/src`). Exclude the 12 uncertain dynamic names above. Do the dead families in batches by file region (1240-1970 detail/fav/bundle; 2203-2300 auth/warning; 3738-3790 split; 9513-9576 fr-*). Also confirms the root `psycle-` removal shrinks U3-1's rename surface by 126 classes.
2. Delete dead ids `#psycle-backdrop-blur`, `#psycle-pause-autobook-btn`, `#favs-modal-close` (grep each in index.html and src, expect 0).
3. Delete the 10 never-referenced custom properties (grep `--name` across `client/src` and index.html returns only the definition).
4. Remove the stale `panel-layout.css` mentions (DESIGN.md:216-218; comments 8738/8740) so nobody "wires it in".
5. Do NOT delete @keyframes (all 16 referenced).

### MEDIUM (small, checkable visual risk)
6. Define or fix the 5 undefined vars (`--surface-hover`, `--radius-sm`, `--surface-3`, `--brand`, `--surface-1`): defining them changes the rendering of those few declarations from "initial" to something intended; pick values deliberately and screenshot the affected rules.
7. Merge the 136 duplicate preludes (start with the five mobile selectors above); consolidate the 7 `:root` blocks and 77 mobile media blocks. Must preserve cascade order; verify with a computed-style diff.
8. Adopt/extend the `u-*` utilities and move the top static inline patterns (section 4) out of timetable.js, settings.js, index.html. Convert `display:none` inline to `hidden`.
9. Tokenise the 358 literal font-sizes and 79 hex values (U3-3), after step 1 shrinks the list.
10. Fix theme-parity gaps (add `:root:not([data-theme="dark"])` twins) after confirming each in a browser in `auto` + light.

### RISKY
11. Remove `!important` (U3-2): needs U3-1 (drop the `#psycle-helper-container` anchor) first, else the arms race returns; do after steps 1 and 7 so far fewer declarations remain (197 vanish with the dead rules alone).
12. Anything touching the `[style*=...]` selectors, the `.psycle-table` column-width rules (see AGENTS.md "Table column widths"), or the dead-looking classes built dynamically.
13. `psycle-` prefix rename (U3-1): out of scope, overlaps steps 1, 11, and the 843-rule `.psycle*` family.

Recommended order: 1 -> 2 -> 3 -> 4 (all SAFE, one commit per batch) -> 7 (dedupe) -> 6 -> 8 -> 9 -> 10 -> 11. Run the full `npm test` after each batch (the client vitest suites read some class names).

## Visual-regression approach (for a later agent)

- Real Chrome via raw CDP on `127.0.0.1:9222` (Playwright `connectOverCDP` is broken on Chrome 154, per memory); one tab only. Dev server in mock mode (`dev@psycle.com`, `dev@jabboxing.mock`).
- Baseline before any edit: for each of Home, Timetable, Bookings, Auto-Book, Credits, Settings (General/Notifications/Account/Your Gyms/gym), onboarding steps, booking/spot-map/calendar modals, filter rail and gym sheet: capture screenshots at 1280x900 and 390x844, in `data-theme=light`, `dark`, and `auto`. Clear SW + CacheStorage + IndexedDB between runs (prod-deploy cache gotcha).
- Plus a computed-style dump: for every element under `#psycle-helper-container`, record `getComputedStyle` for ~30 properties keyed by a DOM path; diff before/after. For SAFE deletions the diff must be empty; for dedupe/tokenisation it must be empty or an explicit, reviewed list.
- Compare screenshots with a pixel diff (threshold 0), store in `Documentation/QA/browser-runs/`.
- Caveat: dead-class verification is static; also load the app with debug mode on and a gym-less account to exercise rarely rendered states before declaring a class dead.

## Step 3 results (2026-10-06): dead-rule removal

- Removed **340 whole rules** (the audit's static estimate was 398), `styles.css` 11,452 -> 9,583 lines (**-1,869**), `!important` tokens 1,127 -> **987** (-140). 7 commits, `css: remove dead rules batch 1..7 (U3-2)`.
- Dead test: every positive class/id in a comma-part (after stripping `:not/:is/:where/:has(...)` and `[attr]`) must be absent as a plain substring from `client/index.html`, `client/public`, `client/src/**` (tests included), `server/**` incl. `admin.html`; and not start/end with a dynamic-built prefix/suffix (`is-`, `state-`, `variant-`, `page-`, `layer-`, `ab-rail-`, `-btn`, `-title`, ...). A rule that cannot match any element has no cascade effect, so no `!important`/source-order unmasking is possible. No partial declarations edited; @keyframes, custom properties and ids-only comments untouched.
- Verification per batch: `npm test` (68/68 server suites, 465/465 client tests), client build, then 56 real-Chrome (CDP :9222, one tab) views (6 tabs + 8 settings pages, light/dark, 1280 and 390 wide, Date and Math.random frozen) compared to 5 pre-change baselines. Computed styles of every non-SVG element under the app root: 0 diffs. Pixels: max residual 29 px per view (the same sporadic antialiasing/logo noise seen between untouched baselines; logo and version-stamp areas masked). A few attempts hit transient load glitches and were re-captured (all batches passed within 4 attempts).
- Kept as uncertain: 65 rules (~363 lines) that are dead by plain substring but share a prefix/suffix with a dynamically built class name. Also kept: orphan section comments, now-unused @keyframes, the 10 unreferenced custom properties, and the three dead ids' sibling declarations are gone only where the whole rule was dead.
- Not covered by the browser views: modals not opened (booking, spot map, calendar), onboarding, gym-less state, debug mode. Dead status for those classes rests on the static grep only.
