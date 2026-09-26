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

## Approach

- One slice per PR. Take a screenshot diff of the main tabs (desktop and mobile, light and dark)
  before and after each slice.
- Watch the `AGENTS.md` gotcha: in this stylesheet `!important` beats specificity. Removing one
  can let a previously dead rule start applying.

**Detail:** [`naming-and-spotmap.md`](../Archive/2026-09-26/Backlog/naming-and-spotmap.md),
[`ui-ux-sweep.md`](../Archive/2026-09-26/Backlog/ui-ux-sweep.md).
