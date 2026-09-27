# U3 — CSS and design-system debt

**Priority:** P3 · **Size:** ~1 week, done in slices · **Depends on:** C4 (don't churn every
screen during live acceptance); U2-1 helps · **Blocks:** nothing

> **Verify first:** before changing anything for an item, confirm its basis in the code **and**, for anything user-visible, **in a real browser** (CDP :9222 or Claude for Chrome). For server-only items, use a failing test or a request. Record the evidence. If a browser check is needed and no browser is available, stop with `BLOCKED`. See [AGENT_PROTOCOL.md](AGENT_PROTOCOL.md).

The live stylesheet is `client/src/styles.css`. `panel-layout.css` is dead code. Counts were
taken on 2026-09-26.

| # | Item | Size of problem | Depends on | Est. |
|---|---|---|---|---|
| U3-1 | **Rename `psycle-` prefixes and `#psycle-helper-container`.** The body carries a Psycle ID in a multi-gym app, and every rule hangs off that ID, which inflates specificity. Rename to a neutral prefix or a class. [naming audit] | `main.js` L976/1099; `psycle-` classes throughout | — | 1 day (mechanical, but touches everything) |
| U3-2 | **Remove `!important`.** | **637** occurrences | U3-1 (lower specificity first, or they come back) | 2 days |
| U3-3 | **Move to the type scale.** | **203** hardcoded `font-size: Npx` vs 46 tokenised | — | 1 day |
| U3-4 | **Move inline styles out of the UI JS.** | **474** `style="…"` plus **272** `.style.x =` in `client/src/ui/*.js` | U2 components absorb some | 1–2 days |
| U3-5 | **Consolidate card typography** across Bookings, Auto-Book and timetable cards. | Design item from 2026-09-02 | U3-3 | 0.5 day |
| U3-6 | **[cosmetic] Sweep leftover "Psycle" and "Psycle Assistant" references in gym-agnostic code.** The app was renamed Sweat Assistant and Psycle is now just one gym. Assess and resolve every Psycle reference in the HTML, CSS, copy, comments and identifiers of core (non-Psycle-specific) code, so nothing implies the app is Psycle's. **Keep** real Psycle-specific references: `gyms.config.js` → `psycle-london`, `providers/codexfit.js` docs, Psycle fixtures and mocks. Classify first, then change. The `psycle-` CSS prefixes and `#psycle-helper-container` belong to U3-1, so do them together. **Persisted keys need a migration, not a rename**: `psycleLocalToken`, `psycleUserId`, `psycleTheme`, `psycleDefaultFilters`, the IndexedDB `psycle-cache` and the `psycle-codex-cart` storage. Renaming them without reading the old key logs every user out and drops their saved filters and theme. Added 2026-09-27 at the user's request. | `grep -rni psycle client/ server/*.html server/*.js`, excluding the provider, gym-config and mock files | Pairs with U3-1 | 1 day (sweep) + ~2 h (key migration) |

## Approach

- One slice per PR. Take a screenshot diff of the main tabs (desktop and mobile, light and dark)
  before and after each slice.
- Watch the `AGENTS.md` gotcha: in this stylesheet `!important` beats specificity. Removing one
  can let a previously dead rule start applying.

**Detail:** [`naming-and-spotmap.md`](../Archive/2026-09-26/Backlog/naming-and-spotmap.md),
[`ui-ux-sweep.md`](../Archive/2026-09-26/Backlog/ui-ux-sweep.md).
