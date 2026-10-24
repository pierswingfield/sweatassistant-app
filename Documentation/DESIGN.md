# Psycle App — Design System

This document is the single source of truth for any agent or developer building UI for this application. Follow it exactly. Do not introduce new color values, components, or patterns without extending this system.

---

## 1. Design Philosophy

**Warm, legible, neutral.** The aesthetic borrows from Anthropic's product language: a warm off-white ground with clay/terracotta as the primary accent. The palette avoids cold blues and harsh saturations. UI should feel like a well-considered native app, not a dashboard.

**Tokens, not raw values.** Every color, radius, and shadow must come from a CSS custom property. Never write hex codes, `rgba()`, or hardcoded values in component CSS. The one exception is `color-mix(in srgb, var(--token) N%, transparent)` for deriving opacity variants from tokens — this is the approved idiom.

**Pastel, not saturated.** Interactive elements (buttons, badges) use desaturated tinted backgrounds so they don't compete with content. The standard pattern for a filled button is `color-mix(in srgb, var(--token) 65-70%, #fff)` on background and `color-mix(in srgb, var(--token) 100%, #000)` on text — producing readable but gentle contrast.

**Light/dark parity.** Every component must be legible in both modes. Test against light mode explicitly — it is the mode most likely to expose legibility failures.

---

## 2. Theme Architecture

The theming system has three layers:

1. **`:root`** — dark values (the default)
2. **`@media (prefers-color-scheme: light) :root:not([data-theme="dark"])`** — system-light override
3. **`:root[data-theme="light"]` / `[data-theme="dark"]`** — manual user override (stored in settings)

The `<html>` element gets `data-theme="light"` or `data-theme="dark"` when the user has explicitly chosen a mode. Without that attribute the system preference applies.

---

## 3. Design Tokens (CSSv2 visual contract, 2026-10-24)

All tokens live in one block at the top of `client/src/styles.css` ("CSSv2 TOKEN LAYER"). Names are neutral and unchanged; values changed. Components read tokens, never literals. Mobile (375-430px) is the design target; desktop must not regress. Contrast numbers below come from `node scripts/contrast.mjs` (WCAG 2.x).

### 3.1 Direction
Warm paper (light) and warm near-black (dark), both derived from the landing ink `#1f1b16`. **Clay is the brand accent in both themes.** The former dark-theme blue is retired as chrome; blue survives only as `--info` (semantic) and the slate `--feat-waitlist`. A gym's own colour appears only on elements that identify that gym (`--gym-*`, injected at runtime by `gym-context.js`); app chrome never reads it and the app accent is never redefined per gym.

### 3.2 Colour tokens and contrast

| Token | Light | Dark | Notes |
|---|---|---|---|
| `--bg` / `--surface` | `#f4f2ec` / `#fbfaf7` | `#161310` / `#201c18` | `--surface-raised`: `#fff` / `#2a2520`; `--header-solid` `#ebeae4` / `#110e0c` |
| `--text` | `#1f1b16` 15.3 bg, 16.4 surface | `#f3ede4` 15.9 bg, 14.5 surface | |
| `--text-secondary` | `#6b6358` 5.3 / 5.7 | `#b9ae9f` 8.5 / 7.8 | |
| `--text-tertiary` | `#736a5d` 4.75 / 5.1 | `#948a7c` 5.5 / 5.0 | captions only, never disabled-looking primary info |
| `--accent` (text, border, focus) | `#a8553a` 4.66 bg, 5.0 surface | `#e09a7f` 8.0 / 7.3 | |
| `--accent-fill` + `--on-accent-fill` | `#b5593d` + `#fff` 4.71 | `#c9785c` + `#1a1411` 5.49 | primary button, selected date, active segment |
| `--brand-clay` (decor only: logo, large glyphs) | `#c9785c` 2.97 (never text) | `#d68b6f` 6.9 | |
| `--cta-wait` / `--cta-auto` + `--on-cta` | `#8a4430` 7.1 / `#6f3524` 9.5 with `#fff` | `#e4b7a2` 10.1 / `#d9967a` 7.5 with `#1a1411` | `--cta-book` = `--accent-fill` |
| `--success` | `#047857` 5.25 | `#4cc794` 8.0 | on surface |
| `--warning` | `#9a6600` 4.71 | `#e5b03e` 8.6 | |
| `--danger` | `#b84343` 5.13 | `#f08a82` 7.0 | destructive fill in light = `--danger` + `#fff` |
| `--info` (only blue) | `#2f6bd1` 4.85 | `#7fb0f0` 7.6 | never interactive chrome |

Borders are warm alpha: `rgba(31,27,22,.10/.18)` light, `rgba(255,238,215,.10/.18)` dark. Plum auto-functions (`--auto*`), discipline tags (`--disc-*`) and feature identity tokens are unchanged in meaning; dark values were re-tuned only where they were cool-blue.

### 3.3 Surfaces and elevation
Level 0 `--bg` (page) -> level 1 `--surface` (cards, rows) with `--shadow-card` -> level 2 `--surface-raised` (popovers, menus) -> sheets/modals `--shadow-sheet`. `--surface-2` is a 3-4% tint for nested blocks, `--surface-inset` for wells. Shadows: light `0 4px 12px rgba(31,27,22,.08)` / `0 18px 48px rgba(31,27,22,.12)`; dark `0 4px 12px rgba(0,0,0,.30)` / `0 18px 48px rgba(0,0,0,.50)`. Dark mode gets elevation mainly from the lighter surface, not the shadow.

### 3.4 Radii and spacing
Radii: `--radius-card` 20, `--radius-control` 12, `--radius-pill` 999, `--radius-sm` 8 (dense inner controls, mobile segment buttons), `--radius-sheet` 24 (sheets, modals). Spacing scale `--space-1..10` = 4, 8, 12, 16, 20, 24, 32, 40 px (new rules use it; legacy `--gap-*`/`--pad-card` stay until Phase 4).

### 3.5 Glass (restrained)
Allowed ONLY on the bottom nav, sticky top bars and modal headers. Tokens: `--glass-bg` (light `rgba(251,250,247,.92)`, dark `rgba(32,28,24,.82)`), `--glass-blur: blur(18px) saturate(1.25)`, `--glass-solid` (opaque fallback), `--glass-edge`. Every glass rule needs `@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px)))` -> `--glass-solid`. Text on composited glass (worst case, page ink or black behind): light secondary text 4.83, primary 14.0, accent 4.26 (large/active icons only; realistic backdrop is the page colour: 5.67 / 16.4 / 5.0); dark secondary 7.4-8.2, primary 13.9-15.3. Status: bottom nav is migrated; the other ~25 `backdrop-filter` declarations in `styles.css` are Phase 3-4 work (cards must not use glass).

### 3.6 Buttons
| Variant | Fill | Text | Border | Use |
|---|---|---|---|---|
| Primary | `--accent-fill` (hover `--accent-fill-hover`) | `--on-accent-fill` | none | one per view/section (Book, Quick Book, Done) |
| Secondary | `--surface-2` | `--text` | 1px `--border-strong` | alternate actions (Filters, Share) |
| Ghost | transparent | `--accent` | none | tertiary, inline links |
| Destructive | `--danger` (light) | `#fff` | none | Cancel booking, delete; dark uses a 14% `--danger` tint fill, a 45% `--danger` border and `--danger` text (no solid red block on the dark surface) |
Height 44px minimum hit area on every interactive control (`--tap-min`); visually smaller controls (32-40px chips) extend their hit area with padding or a `::after` inset. Radius `--radius-control`; dense inline buttons `--radius-sm`. Label: Inter 600 14px.

### 3.7 Focus
One ring everywhere: 2px solid `--accent`, 2px offset (`--focus-ring-width/-offset`). Contrast vs page 4.66 (light) / 8.0 (dark). Never remove outlines without replacing them.

## 4. Typography

### 4.1 Families and type roles
Inter (400/500/600/700) is the UI face; Fraunces (500/600 only) is for three roles. Loaded from Google Fonts in `index.html` with `display=swap`; a metric-matched `Inter Fallback` face (size-adjust 107.6%) removes layout shift while Inter loads. No blanket heading rule: semantic level (h1-h4) is independent of visual role, and the roles are assigned in the TYPE ROLES block of `styles.css` (classes `.t-page-title`, `.t-section`, `.t-stat`, `.t-card-title`, `.t-label`, `.t-caption`, `.t-data` plus the existing component selectors listed there). Do not write `font-family: var(--font-serif)` on a component.

| Role | Family | Size mobile / desktop | Weight | Line-height | Used for |
|---|---|---|---|---|---|
| Page title | Fraunces | 22 / 26px | 600 | 1.15 | tab titles (Home, Class Timetable, My Bookings, Settings), settings pane titles, onboarding titles |
| Section heading | Fraunces | 18px | 600 | 1.3 | Active Bookings, Find a class, modal titles, gym-settings heading |
| Hero figure | Fraunces, lining + tabular nums | 26 / 30px | 600 | 1.05 | credit headline numbers, auto-book countdown banner |
| Card / row title | Inter | 15px | 600 | 1.3 | class name, instructor, settings card titles (h4), booking titles |
| Body | Inter | 14px | 400 | 1.45 | paragraphs, table cells |
| Compact body | Inter | 13px | 400/500 | 1.4 | secondary lines, location |
| Label / badge / chip | Inter | 12px | 600 | 1.4 | pills, chip text, form labels (+.02em tracking) |
| Caption | Inter | 12px (floor) | 400 | 1.45 | helper text, timestamps |
| Button | Inter | 14px (13 compact) | 600 | 1 | all buttons |
| Data (time, count, credits, countdown) | Inter, `tabular-nums` | 15-16px | 600 | 1.2 | timetable times, credit counts; never decorative serif |

Scale tokens: `--text-2xl` 22 (26 at >=769px), `--text-xl` 18, `--text-lg` 16, `--text-md` 15, `--text-base` 14, `--text-sm` 13, `--text-xs` 12. Nothing below 12px.

### 4.2 Tap targets
44px minimum (`--tap-min`), see §3.6. Known sub-44 controls (gym badge, chips, `app-mobile-seg`, share) are tracked in `Documentation/Audits/cssv2-baseline.md` §5 item 9 for Phase 4.

## 5. Color Application Patterns

### 5.1 The `color-mix` idiom

Never write raw `rgba()` for tinting a token. Always use:

```css
/* Subtle tinted background (badges, muted buttons) */
background: color-mix(in srgb, var(--token) 10%, transparent);

/* Hover state */
background: color-mix(in srgb, var(--token) 15%, transparent);

/* Stronger tint */
background: color-mix(in srgb, var(--token) 20%, transparent);
```

### 5.2 Pastel Button Pattern

All timetable/action buttons use this:

```css
/* Fill */
background: color-mix(in srgb, var(--token) 65%, #fff);
color: color-mix(in srgb, var(--token) 100%, #000);
border: 1px solid color-mix(in srgb, var(--token) 30%, transparent);
box-shadow: none; /* never */

/* Hover */
background: color-mix(in srgb, var(--token) 75%, #fff);
```

### 5.3 Muted Outline Pattern

For secondary or destructive secondary buttons:

```css
background: color-mix(in srgb, var(--token) 10%, transparent);
border: 1px solid color-mix(in srgb, var(--token) 25%, transparent);
color: var(--token);
```

### 5.4 Table Rows

```css
/* Even row subtle tint */
background: color-mix(in srgb, var(--text) 2%, transparent);

/* Hover row */
background: color-mix(in srgb, var(--accent) 6%, transparent);
```

---

## 6. Components

### 6.1 Cards

```css
background: var(--surface);
border: 1px solid var(--border);
border-radius: var(--radius-card);
box-shadow: var(--shadow-card);
```

On hover: `border-color: var(--border-strong)`, `background: var(--surface-2)`. No glow.

### 6.2 Modals / Sheets

```css
background: var(--surface);
backdrop-filter: blur(30px) saturate(200%);
border: 1px solid var(--border-strong);
border-radius: var(--radius-sheet);
box-shadow: var(--shadow-sheet);
```

Overlay background: `color-mix(in srgb, var(--bg) 60%, transparent)` with `backdrop-filter: blur(10px)`.

#### 6.2.1 Mobile: every modal is a full-screen page (`modal-nav.js`)

At ≤ 768px a modal must become a full-screen page with its action pinned at the bottom (Done / Save). That is not done with CSS in the modal itself: register the overlay with `openPage` from `client/src/ui/modal-nav.js`. It adds `.app-page` (the full-screen CSS in `styles.css` keys off that class, so an un-registered modal stays a floating card on a phone), a history entry (hardware/iOS back closes it), a scroll lock, dialog semantics, focus and Escape. Above 768px it leaves the centred card alone.

Follow the Preferred Spot Maps manager (`openManageSpotMapsModal` in `settings.js`) or `openCalendarSettingsModal` (`calendar-section.js`):

1. **Markup:** overlay `.app-ovl` > `.app-ovl-card` > `.app-ovl-header` (title `<h3 data-nav-title>`, close `<button data-nav-close>`), `.app-ovl-body` (`flex:1; overflow-y:auto`) and a footer holding the full-width Done / primary button. The footer goes **inside the card** so the page layout pins it to the bottom.
2. **Register:** append the overlay to `document.body`, then `openPage(overlay, { id: '<unique-id>', remove: true, onClose: cleanup })`.
3. **Close:** every close path (×, Done, backdrop, Escape) calls `if (closePage(overlay)) return;` first. On mobile that pops the history entry and the page's `onClose` runs `cleanup`. Only when it returns false (desktop) do you run `cleanup()` and `overlay.remove()` yourself. Put teardown (listeners, callbacks to the opener) in `cleanup` so it runs exactly once on either path.
4. **Stacking:** a modal opened from another page (e.g. from onboarding) is just another `openPage`, so Back returns to the page beneath. Give it the caller's `zIndex` (onboarding passes `1000000`).
5. **Never** build a modal that only has `position:fixed` and a card; it works on desktop and is wrong on a phone. The `Done` footer is required on mobile for onboarding modals.
6. **Test:** with `window.matchMedia` stubbed to match, assert the overlay gets `.app-page` and Done fires `onClose` once (see `client/src/ui/calendar-modal.test.js`).

### 6.3 Inputs & Dropdowns

```css
background: var(--surface-inset);
border: 1px solid var(--border);
border-radius: var(--radius-control);
color: var(--text);
height: 40px;
padding: 0 16px;

/* Focus */
outline: none;
border-color: var(--accent); /* or --feat-autoupgrade for settings */
```

Placeholder text: `color: var(--text-tertiary)`.

### 6.4 Tooltips

Both instructor and occupancy tooltips share:

```css
background: var(--surface);
border: 1px solid var(--border-strong);
border-radius: 16px;
box-shadow: var(--shadow-card);
color: var(--text);
backdrop-filter: blur(20px);
```

**Text inside tooltips:** Use `color: var(--text)` for all descriptive content — not `--text-secondary`. Secondary info (social counts, keywords) uses `color: color-mix(in srgb, var(--accent) 80%, var(--text) 20%)`.

### 6.5 Buttons

#### `.app-btn-primary` — Primary CTA
Used for major actions: Buy, Confirm, Schedule:
```css
background: var(--success); /* or --accent for neutral primary */
color: var(--on-accent);
border-radius: var(--radius-control);
border: none;
box-shadow: none;
```

#### `.app-btn-mini` — Small inline action
Default neutral state:
```css
background: color-mix(in srgb, var(--text) 6%, transparent);
border: 1px solid var(--border-strong);
border-radius: 8px;
color: var(--text);
font-size: 11px;
padding: 4px 10px;
```

Apply a variant class for colored states (see §6.6).

#### `.app-action-btn-mini` — In-list action button
Same as `.app-btn-mini` but with taller minimum height (36px) for use inside cards and table rows.

### 6.6 Button Semantic Variant Classes

Apply on `.app-btn-mini` or `.app-action-btn-mini`:

| Class | Background | Border | Text |
|---|---|---|---|
| `variant-danger` | 10% danger | 25% danger | `--danger` |
| `variant-danger-strong` | 20% danger | `--danger` solid | `--danger`, bold |
| `variant-warning` | 15% warning | 30% warning | `--warning` |
| `variant-warning-solid` | `--warning` solid | none | `--on-accent` |
| `variant-success` | `--success` solid | none | `--on-accent` |
| `variant-success-muted` | 15% success | 30% success | `--success` |
| `variant-autoupgrade` | 15% autoupgrade | 35% autoupgrade | `--feat-autoupgrade` |
| `variant-neutral` | 6% text | 15% text | `--text-secondary` |
| `variant-debug` | 25% autoupgrade | 40% autoupgrade | `--feat-autoupgrade`, 10px |

### 6.7 Timetable Action Buttons

These appear inside timetable rows. All use the pastel pattern (§5.2):

| Button | Token | Notes |
|---|---|---|
| Book | `--success` | Primary booking action |
| Quick Book | `--success` | Matches Book — same green |
| Auto Book | `--feat-autoupgrade` | Pastel violet |
| Waitlist | `--orange` | Pastel orange — not amber |
| Booked (badge) | `--success` muted outline | Non-interactive state indicator |
| On Waitlist (badge) | `--orange` muted outline | Non-interactive state indicator |
| Cancel | `--danger` muted outline | Lightweight destructive |
| Leave Waitlist | `--orange` muted outline | Lightweight |

**No `box-shadow` on any timetable button. No colored glows.**

### 6.8 Split Buttons (Quick Book / Auto Book with settings cog)

```css
/* Container */
display: inline-flex;
border-radius: 4px;
overflow: hidden;
box-shadow: none; /* no shadow */

/* Main part — pastel */
background: color-mix(in srgb, var(--token) 70%, #fff);
color: color-mix(in srgb, var(--token) 100%, #000);

/* Cog part — slightly richer */
background: color-mix(in srgb, var(--token) 80%, #fff);
border-left: 1px solid color-mix(in srgb, var(--on-accent) 15%, transparent);

/* Scheduled/active state — muted outline */
background: color-mix(in srgb, var(--token) 15%, transparent);
color: var(--token);
border: 1px solid color-mix(in srgb, var(--token) 30%, transparent);
```

### 6.9 Badges / Pills (`.badge-pill`)

Base:
```css
display: inline-flex;
align-items: center;
font-size: 10px;
font-weight: 600;
text-transform: uppercase;
letter-spacing: 0.4px;
border-radius: 4px;
padding: 2px 6px;
border: 1px solid;
```

| Modifier | Text | Background | Border |
|---|---|---|---|
| `.yes` | `--success` | 10% success | 20% success |
| `.no` | `--danger` | 10% danger | 20% danger |
| `.valid` | `--success` | 10% success | 20% success |
| `.invalid` | `--warning` | 10% warning | 20% warning |
| `.badge-available` | `--success` | 10% success | 20% success |
| `.badge-restricted` | `--warning` | 10% warning | 20% warning |
| `.not-live` | `--text-secondary` | transparent | `--border` |
| `.fully-booked` | `--danger` | 10% danger | 20% danger |

### 6.10 Status Cells (`.status-cell`) in Tables

```css
/* Base */
display: inline-block;
font-size: 11px;
font-weight: 600;
padding: 3px 8px;
border-radius: 6px;
border: 1px solid;
```

`.yes` → success colors. `.no` → danger colors. Custom states use inline `color:` + `border-color:` with token values.

### 6.11 Filter Bars

```css
/* Filter bar container */
background: var(--surface-inset);
border-bottom: 1px solid var(--separator);
padding: 12px 36px;
display: flex;
align-items: center;
flex-wrap: wrap;
gap: 12px;
```

Checkbox filters inside a bar: transparent background, no nested surface. Labels use `--text-secondary`, hover to `--text`.

### 6.12 Tables

```css
/* th */
background: var(--surface-inset);
color: var(--text-secondary);
font-size: 11px;
font-weight: 600;
text-transform: uppercase;
letter-spacing: 0.5px;
border-bottom: 1px solid var(--border);

/* td */
color: var(--text);
border-bottom: 1px solid var(--separator);

/* strong inside td */
color: var(--text);

/* Even row */
background: color-mix(in srgb, var(--text) 2%, transparent);

/* Hover row */
background: color-mix(in srgb, var(--accent) 6%, transparent);
```

### 6.13 Section Sub-headers

```css
/* Used in Buy Credits between Favourite Bundles and All Credits */
font-family: var(--font-serif);
font-size: 16px;
font-weight: 600;
color: var(--text);
margin-bottom: 12px;
```

### 6.14 Countdown / Status Badges (Auto-Book Cards)

| State | Background | Text color |
|---|---|---|
| Pending | 15% `--feat-autoupgrade` | `--feat-autoupgrade` |
| Firing | 15% `--warning` | `--warning` |
| Success | 15% `--success` | `--success` |
| Failed | 15% `--danger` | `--danger` |

### 6.15 Heart / Bookmark Icon

```css
/* Saved/bookmarked */
color: var(--danger); /* no glow, no drop-shadow */

/* Unsaved */
color: color-mix(in srgb, var(--text) 35%, transparent);

/* Loading */
opacity: 0.5;
pointer-events: none;
```

### 6.16 Occupancy / Minimap

Minimap sits inside the occupancy tooltip. Dots:

```css
.app-minimap-dot.available { background: var(--success); }
.app-minimap-dot.occupied  { background: var(--danger); }
```

Loading spinner inside the tooltip uses `color: var(--feat-autoupgrade)` for the arc and `color: var(--text)` for label text.

---

## 7. Scrollbars

All scrollbars use token-derived values:

```css
scrollbar-width: thin;
scrollbar-color: color-mix(in srgb, var(--text) 15%, transparent) transparent;

/* Webkit */
::-webkit-scrollbar { width: 5px; height: 5px; }
::-webkit-scrollbar-track { background: color-mix(in srgb, var(--text) 3%, transparent); }
::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--text) 15%, transparent); border-radius: 4px; }
::-webkit-scrollbar-thumb:hover { background: color-mix(in srgb, var(--text) 30%, transparent); }
```

---

## 8. Spacing & Layout

| Context | Padding |
|---|---|
| Panel content | `24px 36px` |
| Filter bars | `12px 36px` |
| Section gap | `24px` between sections |
| Element gap | `12px` between related elements |
| Card padding | `14–16px` |
| Button (mini) | `4–6px 10–12px` |
| Button (primary) | `8–10px 16–20px` |

---

## 9. Motion

Tokens (Phase 5 adopts them; existing 23 ad-hoc durations migrate to these): durations `--dur-fast` 100ms (press, colour), `--dur-base` 180ms (hover, toggles), `--dur-slow` 240ms (cards, sheets opening), `--dur-page` 300ms (tab/page transitions); easings `--ease-out` `cubic-bezier(.25,1,.5,1)` (entrances, default) and `--ease-in-out` `cubic-bezier(.4,0,.2,1)` (moves between two resting states). Animate `transform` and `opacity` only. Every animation must be neutralised by the existing `prefers-reduced-motion: reduce` rules.

**Implemented (Phase 5).** All durations/easings in `styles.css` use the tokens (loop-only timings such as spinners keep their own). Patterns: mobile full-screen pages slide in from the right (`--dur-slow`, `translateX(100%)` to none; `modal-nav.js` removes the page after its 300 ms hide timer, so a missed `transitionend` cannot strand an overlay); desktop modals fade + 12px rise; tab change plays `tab-enter-fwd/back` (opacity + 14px, direction from bottom-nav order, class removed on `animationend` with a 400 ms fallback); the timetable's first arrival staggers the first 8 rows at 24 ms steps (`app-stagger-in`, once per session, never on re-render); a confirmed favourite and a tapped spot pop once (`is-pop`, 100-180 ms); a success toast settles its icon once. Reduced motion is one block at the end of `styles.css`: transitions 1 ms, one-shot animations off, pages and toasts keep an opacity fade only; spinners stay (progress, not decoration).

## 10. Anti-Patterns

**Do not do these:**

| Anti-pattern | Correct approach |
|---|---|
| `color: #94a3b8` | `color: var(--text-secondary)` |
| `background: rgba(255,255,255,0.1)` | `background: color-mix(in srgb, var(--text) 10%, transparent)` |
| `box-shadow: 0 4px 14px rgba(16,185,129,0.4)` on a button | `box-shadow: none` — no glows on buttons |
| `color: #8b5cf6` (raw violet) | `color: var(--feat-autoupgrade)` |
| `background: #10b981` (raw green) | `background: var(--success)` or pastel mix |
| Inline `style="color:#fff"` on HTML elements | CSS class with token |
| `h3` without serif | `font-family: var(--font-serif)` on all headings |
| Using `--warning` for waitlist buttons | Use `--orange` for waitlist action buttons |
| Using `--feat-autoupgrade` violet outside Auto-Upgrade | Reserved — do not repurpose |
| Custom `--shadow-*` values | Use only `var(--shadow-card)` or `var(--shadow-sheet)` |
| Description text in tooltip as `--text-secondary` | Tooltip body text must be `var(--text)` |

---

## 11. File Reference

| File | Role |
|---|---|
| `client/src/styles.css` | All tokens, all component CSS (the only stylesheet loaded by the app) |
| `client/index.html` | Panel/section HTML structure, modals, iOS bottom nav |
| `client/src/ui/timetable.js` | Timetable row/button rendering, filters, booking modal, mobile cards |
| `client/src/ui/bookings.js` | My Bookings panel, cancel/leave logic, edit-spots + upgrade modals |
| `client/src/ui/credits.js` | Buy Credits panel, bundle cards, in-app cart + Stripe checkout |
| `client/src/ui/autobook.js` | Auto-Book queue/history rendering, SSE stream, countdown, favourites |
| `client/src/ui/autoupgrade.js` | Auto-Upgrade monitor list (rendered inside Auto-Book tab) |
| `client/src/ui/settings.js` | Settings panel (4 subnav sections), theme toggle, calendar card, notif prefs, Profile Explorer, spot-map manager |
| `client/src/ui/spotmap.js` | Shared studio floor-plan editor (reused by all booking flows + settings) |
| `client/src/ui/tooltips.js` | Instructor + occupancy tooltip HTML (hover + touch tap-to-toggle) |
| `client/src/ui/onboarding.js` | First-run 6-step guided flow |
| `client/src/ui/pulltorefresh.js` | Reusable pull-to-refresh for scroll containers |
| `client/src/ui/cards.js` | Shared SVG icon set, discipline tags, card text helpers |
| `client/src/main.js` | App bootstrap, auth, tab routing, push, theme, offline, pull-to-refresh |

> **Note:** `client/src/panel-layout.css` exists but is **not loaded** by the app (only `styles.css` is imported in `index.html`). Do not assume its rules apply.
