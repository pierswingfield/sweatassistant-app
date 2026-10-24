# Workstreams — active roadmap

This folder holds the active epics, recurring onboarding playbook, and [central backlog](BACKLOG.md). Detailed completed work and superseded plans live in [`Documentation/Archive/`](../Archive/).

Before starting an item, follow [AGENT_PROTOCOL.md](AGENT_PROTOCOL.md): confirm the issue in the code and, for user-visible work, in a real browser; then verify the change. Keep the stable task IDs below when referring to work.

## Current work

| Epic | Focus | Active work |
|---|---|---|
| [Reported bugs and feedback](EPIC-member-experience.md) | Active register for the bugs and UI changes reported by the user; all U6 items are open pending implementation and verification. | U6-1..U6-15; U4-19 `q` search URL wiring |
| [Admin and operations](EPIC-admin-operations.md) | Improve durable admin data and finish user-owned production setup. | C8-1; C4-14 |
| [Dibs landing page](M-landing-page.md) | Public glass-style marketing page with an install CTA and server-side analytics. Specified, not built. | M-D1..M-D8 |
| [Gym onboarding playbook](C9-gym-onboarding.md) | Repeatable tenant onboarding, provider evidence, and activation process. | Ongoing process, used when a gym is added |

Lower-priority, deferred, research-first, and user-dependent items belong in [BACKLOG.md](BACKLOG.md), not in active epic documents.

## Proposed work plans

Requested 2026-10-24; these plans do not mark implementation as started or verified.

| Plan | First milestone | Relationship to existing work |
|---|---|---|
| [App restyling, typography, CSS and motion](PLAN-app-restyling.md) | Real-browser baseline audit, then visual rules and reference screens | Coordinates the existing CSS/type cleanup and glass-polish backlog; preserves member-experience bug ownership |
| [User-facing MCP server](PLAN-mcp-server.md) | Client/auth compatibility spike and threat model, then a read-only pilot | Expands F-4, the MCP integration; includes [current security research](mcp-security-research.md) |

The two plans can progress independently. The MCP connection/consent UI should reuse the app's shared design components. The restyling audit requires real-browser access before implementation, as described in the agent protocol.

## Repository context

- `master` is the working branch; Home is merged at `2e93f9e`.
- C4 production-launch details are archived. The remaining C4-14 step is an account setup action on production; verify current production state before acting.
- Historical acceptance and deployment evidence is preserved under [`../Archive/2026-10-08/`](../Archive/2026-10-08/).

## Filing rules

- Keep active epic documents short: current outcomes, task IDs, dependencies, and acceptance notes.
- Move deferred work to BACKLOG.md. Keep its original ID and a short concrete description.
- Archive completed specs and implementation logs; do not keep archived checklists in the active roadmap.
- Put future tenant onboarding evidence in C9. Keep C9 as the recurring playbook rather than duplicating it in each epic.
