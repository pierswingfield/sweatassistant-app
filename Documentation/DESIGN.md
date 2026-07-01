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

## 3. Design Tokens

All tokens are defined in `client/src/styles.css` at the top of the file.

### 3.1 Surfaces

| Token | Dark | Light | Usage |
|---|---|---|---|
| `--bg` | `#090d16` | `#f5f2ec` | Page/panel background |
| `--surface` | `rgba(20,24,38,0.65)` | `#fbfaf7` | Cards, sheets, overlays |
| `--surface-2` | `rgba(255,255,255,0.03)` | `rgba(31,27,22,0.03)` | Subtle hover lift |
| `--surface-inset` | `rgba(0,0,0,0.2)` | `rgba(31,27,22,0.04)` | Inputs, filter bars, recessed areas |

### 3.2 Text

| Token | Dark | Light | Usage |
|---|---|---|---|
| `--text` | `#f1f5f9` | `#1f1b16` | Primary body copy |
| `--text-secondary` | `#94a3b8` | `#6b6358` | Labels, captions, helper text |
| `--text-tertiary` | `#64748b` | `#938a7c` | Disabled, placeholder |

### 3.3 Borders & Separators

| Token | Dark | Light | Usage |
|---|---|---|---|
| `--border` | `rgba(255,255,255,0.08)` | `rgba(31,27,22,0.10)` | Default card/input border |
| `--border-strong` | `rgba(255,255,255,0.16)` | `rgba(31,27,22,0.18)` | Active focus, drawer edges |
| `--separator` | `rgba(255,255,255,0.06)` | `rgba(31,27,22,0.07)` | Table rows, section dividers |

### 3.4 Accent (Primary Brand)

| Token | Dark | Light | Usage |
|---|---|---|---|
| `--accent` | `#d2876b` | `#c9785c` | Primary interactive color (Anthropic clay) |
| `--accent-hover` | `#c9785c` | `#b5694e` | Hovered accent |
| `--on-accent` | `#1a1815` | `#ffffff` | Text/icon on colored accent backgrounds |

### 3.5 Semantic Colors

| Token | Dark | Light | Usage |
|---|---|---|---|
| `--success` | `#34d399` | `#059669` | Booked state, positive confirmation |
| `--warning` | `#fbbf24` | `#c2870a` | Caution, partial state |
| `--danger` | `#f87171` | `#dc2626` | Cancel, error, destructive |
| `--info` | `#60a5fa` | `#3b82f6` | Info badges |
| `--orange` | `#f97316` | `#ea580c` | Waitlist buttons specifically |

### 3.6 Feature Identity Tokens

These are canonical colors for specific product features. They must not bleed into unrelated UI.

| Token | Dark | Light | Feature |
|---|---|---|---|
| `--feat-autobook` | `#d2876b` | `#c9785c` | Auto-Book (clay, same as `--accent`) |
| `--feat-autoupgrade` | `#a78bfa` | `#7c5cdb` | Auto-Upgrade — violet, reserved |
| `--feat-quickbook` | `#fbbf24` | `#c2870a` | Quick-Book (amber) |
| `--feat-waitlist` | `#60a5fa` | `#3b82f6` | Waitlist status badge |
| `--orange` | `#f97316` | `#ea580c` | Waitlist action button |

**Rule:** Violet (`--feat-autoupgrade`) is strictly reserved for Auto-Upgrade UI. Do not use it as a general accent or action color.

### 3.6a Auto-Functions Plum & Discipline Tags

**Auto-functions brand (plum).** The redesigned Auto-Book panel uses a plum
purple as the shared brand for *automation* surfaces (the release-countdown
banner, per-class countdown chips, "spots required" pills). It is intentionally
distinct from the clay `--accent` so automation reads as its own family. Per
product direction this plum is the shared auto colour for both Auto-Book and
Auto-Upgrade.

| Token | Dark | Light | Usage |
|---|---|---|---|
| `--auto` | `#c9aed6` | `#6d4c7d` | Tint/chip text on standard surfaces (countdown chip, spots pill) |
| `--auto-banner` | `#5a3e63` | `#5a3e63` | Filled banner surface (white text) |
| `--on-auto` | `#ffffff` | `#ffffff` | Text/icon on the filled `--auto-banner` |

### 3.6b Timetable Redesign & Button Styles

To support the mid-2026 timetable button visual clean-up, the following variables and colors are established. These styles prioritize borderless designs and clear typographic contrasts.

| Token | Dark | Light | Target / Component |
|---|---|---|---|
| `--accent-btn-bg` | `#402418` | `var(--accent)` | Background of Book and Quick-Book primary action buttons |
| `--on-accent-button` | `#e8a287` | `#FEF1E9` | Text/cog on Book and Quick-Book buttons |
| `--on-auto-pill` | `#c9aed6` | `#E2D1DD` | Text/cog on Scheduled Auto-Book button and status badge |
| `--auto-not-scheduled` | `#3d2642` | `#D2BDD9` | Background of Auto-Book button when NOT scheduled |
| `--on-auto-not-scheduled` | `#c9aed6` | `#5A3E63` | Text/cog of Auto-Book button when NOT scheduled |
| `--waitlist-btn-bg` | `#2e1d1a` | `#825f58` | Background of Join Waitlist action button and Waitlisted status badge |
| `--on-waitlist-btn` | `#c9a49e` | `#FEF1E9` | Text on Join Waitlist button and Waitlisted status badge |
| `--buy-credits-bg` | `#301712` | `#5E382B` | Background of Buy Credits primary action button |
| `--on-buy-credits` | `#e8a287` | `#FEF1E9` | Text on Buy Credits button |
| `--no-credits-warning-color` | `#E6AA9C` | `#5E382B` | Color of "No eligible credits" warning in status column |

**Rule:** Timetable action buttons and status badges must be borderless (`border: none`). Desktop action groups with a configuration caret (⚙) are separated by a 1px vertical divider line colored dynamically matching `currentColor` at 20% opacity.

**Discipline tags.** Each queued/history class shows a pastel tag coloured by its
workout discipline, derived from `group_name` (falls back to `class_name`). Tags
follow the badge tint pattern: text = token, background `14%`, border `24%`.
Purple is **not** used here — it is reserved for the auto-functions above.

| Token | Dark | Light | Discipline (name match) |
|---|---|---|---|
| `--disc-ride` | `#5ec6c6` | `#2f8f8f` | Ride / cycle / spin (teal) |
| `--disc-barre` | `#e8a0b4` | `#c25d7a` | Barre (pink) |
| `--disc-strength` | `#e0aa5a` | `#a9761a` | Strength / tone / sculpt / HIIT / Signature (amber) |
| `--disc-infrared` | `#f0907e` | `#cc5340` | Infrared / hot / sweat (coral) |
| `--disc-reformer` | `#85aadb` | `#4775ad` | Reformer / pilates (blue) |
| `--disc-yoga` | `#8fc98f` | `#4f9b5f` | Yoga / flow / mind (sage) |
| `--disc-other` | `#b3a99f` | `#857a6e` | Fallback (warm grey) |

Tags and rail/footer controls render their glyphs as **inline SVG** themed via
`currentColor` (the shared icon set lives in `client/src/ui/cards.js`), not an icon
font.

### 3.7 Shape & Shadow

| Token | Dark value | Light value | Usage |
|---|---|---|---|
| `--radius-card` | `16px` | same | Cards, info panels |
| `--radius-control` | `12px` | same | Buttons, inputs, dropdowns |
| `--radius-sheet` | `24px` | same | Modals, bottom sheets |
| `--shadow-card` | `0 4px 12px rgba(0,0,0,0.15)` | `0 4px 12px rgba(31,27,22,0.08)` | Floating cards |
| `--shadow-sheet` | `0 16px 40px rgba(0,0,0,0.2)` | `0 16px 40px rgba(31,27,22,0.12)` | Modals, sheets |

**Shadow discipline:** Use only `var(--shadow-card)` or `var(--shadow-sheet)`. Do not add custom `box-shadow` values. Never add colored glows to buttons.

---

## 4. Typography

### 4.1 Font Stacks

| Token | Stack | Usage |
|---|---|---|
| `--font-serif` | Fraunces, Source Serif 4, Georgia, Times New Roman | **All headings (h1–h4)** |
| `--font-sans` | Inter, system-ui, -apple-system | All body, labels, buttons |
| `--font-mono` | SF Mono, Fira Code, Consolas | Timestamps, IDs, monospace values |

**Rule:** Every `h1`–`h4` must use `font-family: var(--font-serif)`. This applies everywhere — panels, modals, tooltips, cards, drawers.

### 4.2 Type Scale

**Accessibility floor: 12px.** No rendered text may be smaller than 12px. The
scale below was raised from earlier 10–11px lows to meet this floor; hierarchy is
carried by weight, colour, and serif/sans contrast rather than by sub-12px sizing.
Sizes are tokenised in `styles.css` (`--text-xs`…`--text-2xl`) — use the tokens,
never a raw `px` for type.

| Role | Token | Size | Weight | Font | Usage |
|---|---|---|---|---|---|
| Panel title | `--text-2xl` | 22px | 600 | Serif | Main tab/panel heading |
| Section header | `--text-xl` | 18px | 600 | Serif | `h3` inside sections |
| Card heading | `--text-lg` | 16px | 600–700 | Serif | `h4` in cards / sub-headers |
| Large body | `--text-md` | 15px | 500 | Sans | Emphasised copy |
| Body | `--text-base` | 14px | 400–500 | Sans | Copy, table cells |
| Compact body | `--text-sm` | 13px | 400–500 | Sans | Dense copy |
| Label / Caption / Mono | `--text-xs` | 12px | 500–600 | Sans/Mono | Filter labels, meta, helper, timestamps, IDs — **floor** |

### 4.3 Tap Targets & Focus (Accessibility)

- **44px minimum hit target** (WCAG 2.5.5) on all primary action controls —
  nav buttons, segmented buttons, primary/mini/action buttons, day pills,
  timetable book/waitlist/cancel/leave buttons, split-button groups, dropdown
  triggers, inputs, and selects. Enforced via `--tap-min: 44px` on every viewport.
- **Exemption:** spacing-constrained controls inside the studio/spot map (slot
  bubbles, row-select dots) are exempt per WCAG 2.5.5's essential-spacing clause.
  They keep their compact size; where a larger hit area is needed they opt into
  `.tap-compact`, which expands the *hit area* to 44px without changing visual size.
- **Visible focus:** every interactive element shows a `:focus-visible` outline
  (`2px solid var(--accent)`, `outline-offset: 2px`). Border-colour change alone
  is not sufficient for keyboard accessibility.
- **Checkboxes/radios** are sized 20px for tappability.

> **Note:** `client/src/panel-layout.css` is **not loaded** by the app (nothing
> imports it; Vite ships only `styles.css`). Treat `styles.css` as the single
> rendered stylesheet. `panel-layout.css` is stale and should be deleted or wired
> in deliberately — do not assume its rules apply.

---

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

#### `.psycle-btn-primary` — Primary CTA
Used for major actions: Buy, Confirm, Schedule:
```css
background: var(--success); /* or --accent for neutral primary */
color: var(--on-accent);
border-radius: var(--radius-control);
border: none;
box-shadow: none;
```

#### `.psycle-btn-mini` — Small inline action
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

#### `.psycle-action-btn-mini` — In-list action button
Same as `.psycle-btn-mini` but with taller minimum height (36px) for use inside cards and table rows.

### 6.6 Button Semantic Variant Classes

Apply on `.psycle-btn-mini` or `.psycle-action-btn-mini`:

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
.psycle-minimap-dot.available { background: var(--success); }
.psycle-minimap-dot.occupied  { background: var(--danger); }
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

| Name | Easing | Duration | Usage |
|---|---|---|---|
| Standard | `ease` | `0.15–0.2s` | Color, opacity, border transitions |
| Spring | `cubic-bezier(0.25, 1, 0.5, 1)` | `0.2–0.35s` | Position, transform, scale |

- Modal entry: `translateY(24px) → translateY(0)` + opacity, 0.35s spring
- Tooltip show: `scale(0.95) + opacity:0 → scale(1) + opacity:1`, 0.2s ease
- Button hover: `translateY(-1px)`, 0.2s ease — only on primary CTAs, not timetable buttons

No bounce. No elastic. No overshoot. Transitions should be felt, not noticed.

---

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
