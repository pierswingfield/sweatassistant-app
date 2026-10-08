# U3 — CSS and design-system debt

> **Archived 2026-10-08.** Remaining U3-1..6 design-system maintenance is in the [central backlog](../../Workstreams/BACKLOG.md). The dead-rule cleanup is complete; this file preserves the broader audit and approach.

**Priority:** P3 · **Status (2026-10-08): OPEN.** The unused-rule cleanup landed, but the broader design-system work remains. The 2026-10-06 audit measured substantial remaining CSS debt; counts below are audit snapshots unless marked post-cleanup. · **Depends on:** C4 (complete); U2-1 helps · **Blocks:** nothing

> **Verify first:** before changing anything for an item, confirm its basis in the code **and**, for anything user-visible, **in a real browser** (CDP :9222 or Claude for Chrome). For server-only items, use a failing test or a request. Record the evidence. If a browser check is needed and no browser is available, stop with `BLOCKED`. See [AGENT_PROTOCOL.md](../../Workstreams/AGENT_PROTOCOL.md).

The live stylesheet is `client/src/styles.css`. `panel-layout.css` is dead code. Counts were
taken on 2026-09-26.

| # | Item | Size of problem | Depends on | Est. |
|---|---|---|---|---|
| U3-1 | **Rename `psycle-` prefixes and `#psycle-helper-container`.** The body carries a Psycle ID in a multi-gym app, and every rule hangs off that ID, which inflates specificity. Rename to a neutral prefix or a class. [naming audit] | `main.js` L976/1099; `psycle-` classes throughout | — | 1 day (mechanical, but touches everything) |
| U3-2 | **Reduce `!important` overrides.** Dead-rule cleanup removed 140; **987 grep matches remain**. | Audit counted 1,108 declarations before cleanup | U3-1 (lower specificity first, or they come back) | 2 days |
| U3-3 | **Use the type scale instead of literal sizes.** Audit found **358** hard-coded pixel sizes vs 78 tokenized before dead-rule cleanup. | See [CSS debt audit](../../Audits/css-debt-audit.md) | — | 1 day |
| U3-4 | **Move inline styles out of UI markup/code.** Audit: 525 JS attributes, 165 in `index.html`, 399 `.style.x =`, and 51 `style.cssText` before dead-rule cleanup. | See [CSS debt audit](../../Audits/css-debt-audit.md) | U2 components absorb some | 1–2 days |
| U3-5 | **Consolidate card typography** across Bookings, Auto-Book and timetable cards. | Design item from 2026-09-02 | U3-3 | 0.5 day |
| U3-6 | **[cosmetic] Sweep leftover "Psycle" and "Psycle Assistant" references in gym-agnostic code.** The app was renamed Sweat Assistant and Psycle is now just one gym. Assess and resolve every Psycle reference in the HTML, CSS, copy, comments and identifiers of core (non-Psycle-specific) code, so nothing implies the app is Psycle's. **Keep** real Psycle-specific references: `gyms.config.js` → `psycle-london`, `providers/codexfit.js` docs, Psycle fixtures and mocks. Classify first, then change. The `psycle-` CSS prefixes and `#psycle-helper-container` belong to U3-1, so do them together. **Persisted keys need a migration, not a rename**: `psycleLocalToken`, `psycleUserId`, `psycleTheme`, `psycleDefaultFilters`, the IndexedDB `psycle-cache` and the `psycle-codex-cart` storage. Renaming them without reading the old key logs every user out and drops their saved filters and theme. Added 2026-09-27 at the user's request. | `grep -rni psycle client/ server/*.html server/*.js`, excluding the provider, gym-config and mock files | Pairs with U3-1 | 1 day (sweep) + ~2 h (key migration) |

## Approach

- One slice per PR. Take a screenshot diff of the main tabs (desktop and mobile, light and dark)
  before and after each slice.
- Watch the `AGENTS.md` gotcha: in this stylesheet `!important` beats specificity. Removing one
  can let a previously dead rule start applying.

**Detail:** [`naming-and-spotmap.md`](../2026-09-26/Backlog/naming-and-spotmap.md),
[`ui-ux-sweep.md`](../2026-09-26/Backlog/ui-ux-sweep.md).
