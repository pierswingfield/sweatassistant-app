# Psycle UX Upgrade — Design System & Plan

In-place re-skin of the existing vanilla-JS + Vite PWA. **No framework swap, no functionality loss.**
The JS contract (element IDs + `data-*` hooks) is preserved; only CSS, classes, and wrapper
structure change. Each phase ships independently and is revertible.

## Decisions (locked)
1. **Accent**: full Anthropic clay as primary; today's purple demoted to the Auto-Upgrade feature hue.
2. **Typography**: serif on all headings (page/tab/section/card titles); sans for body, data, controls.
3. **Theme default**: follow the system (`prefers-color-scheme`), with a manual Auto/Light/Dark override.
4. **About tab**: folded into Settings on **mobile only**; desktop keeps the standalone About tab.

## Design tokens
A single CSS-variable layer drives theming. Dark values are seeded to match the *current* look so
adopting tokens is visually invisible until we deliberately flip. Light values via
`@media (prefers-color-scheme: light)`; manual override via `[data-theme="light|dark"]` on the root.

Token groups: `--bg/--surface/--surface-2/--surface-inset`, `--text/--text-secondary/--text-tertiary`,
`--border/--border-strong/--separator`, `--accent/--accent-hover/--on-accent`,
feature identity `--feat-autobook/--feat-autoupgrade/--feat-quickbook/--feat-waitlist`,
semantic `--success/--warning/--danger/--info`, plus radius/shadow tokens.

### Palette (anchors)
| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `#F5F2EC` | `#1A1815` | app canvas |
| `--surface` | `#FBFAF7` | `#252220` | cards |
| `--accent` | `#C9785C` | `#D2876B` | primary actions, active nav, focus |
| `--text` | `#1F1B16` | `#EDEAE3` | body |

### Feature identity (used on buttons, queue cards, settings, and push styling)
| Feature | Hue | Icon |
|---|---|---|
| Auto-Book | clay (primary) | calendar + bolt |
| Auto-Upgrade | violet | chevron-up |
| Quick-Book | amber | lightning |
| Waitlist | slate-blue | hourglass |

Functional/semantic colors stay saturated for legibility (a credit warning must read as a warning).

## Typography
- Headings: **serif** (Fraunces / Source Serif 4, Google-hosted).
- Body/data/controls: **Inter** (already loaded) with `tabular-nums` for countdown, credits, tables.
- Debug terminal: monospace (unchanged).
- Defined scale (≈34/28/22/17/15/13) mapped to tokens.

## Responsive architecture
One DOM, two presentations switched by CSS at ~768px.
- **Mobile (iOS 26)**: bottom tab bar (Timetable, Bookings, Auto-Book, Credits, Settings; About folded
  into Settings) reusing existing `data-tab` buttons; large-title collapsing headers; sheet modals with
  grabber + detents (floor plan = full-screen sheet); grouped inset lists for Settings; tables reflow to
  stacked cards; filters as sheet/chip row; 44px tap targets; tap/long-press for hover tooltips.
- **Desktop**: refined max-width container; restyled top/segmented nav; multi-column card grids; tables
  stay tabular; hover floor-plan minimaps unchanged.

## Phases
1. **Token foundation** — variable layer + light/dark + Auto/Light/Dark toggle in Settings; map hexes → tokens. *(Visually invisible at first.)*
2. **Typography** — serif headings + scale.
3. **Component kit + feature identity** — unify buttons, chips, badges, switches, selects, cards; apply per-feature color/icon system everywhere incl. notifications.
4. **Mobile shell** — bottom tab bar, large-title headers, safe-area insets, sheet modals.
5. **Per-view mobile adaptation** — tables→cards, Settings→grouped lists, floor-plan→fullscreen sheet, filters→sheet/chips.
6. **Polish** — motion, skeleton loaders, empty states, light-mode contrast QA on seat-map glows.

## No-breakage rules
- Never rename element IDs or `data-*` hooks the JS reads.
- Bottom-tab/header buttons reuse the existing `data-tab` switch in `main.js`.
- The ~470 inline color literals (esp. `timetable.js`) are migrated to tokens incrementally; CSS
  specificity overrides bridge until each is converted.
