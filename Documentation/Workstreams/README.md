# Workstreams — Sweat Assistant roadmap

**This folder is the single source of truth for what's next.** It replaced `BACKLOG.md`,
`Backlog/*` and `Backlog/modular-gyms/*` on 2026-09-26. Those files are frozen in
[`../Archive/2026-09-26/`](../Archive/2026-09-26/). Their status markers are stale, but their
design detail is still valid, and items below link to it.

> **Before working any item, follow [AGENT_PROTOCOL.md](AGENT_PROTOCOL.md).** Verify the basis of
> the bug or change in the code **and in a real browser** before changing anything. Fail hard if
> no real browser is available. Use Gemini offload for reading and triage.

Status last tidied **2026-10-06** after merging the 5-10 enhancements worktree and the guest-cancel /
entitlement work into `modular`. **Finished workstreams are moved to
[`../Archive/2026-10-06/`](../Archive/2026-10-06/)** (C1, C3, U1). Each remaining doc opens with a
dated STATUS line; open items are the only thing left to do.

## Where things stand

| | |
|---|---|
| **Prod** (`sweat.wingfield.tech`) | Old single-gym `master` build. Psycle only. **Buy Credits is broken here**: every v1 cart endpoint it calls is retired upstream. |
| **Dev twin** (`sweat-dev.wingfield.tech`) | `modular` branch: multi-gym (Psycle/CodexFit + JAB/MarianaTek), merged timetable, per-account calendar, restructured Settings. JAB is enabled there by env var. |
| **The milestone** | Promote `modular` to prod, then enable JAB for real users (**C4**). Most of the work below either blocks that or can wait until after it. |

## Workstreams

### Core functionality

| ID | Workstream | Priority | Size |
|---|---|---|---|
| C1 (archived) | ✅ **FINISHED, archived 2026-10-06** — [Archive/2026-10-06/C1-critical-fixes.md](../Archive/2026-10-06/C1-critical-fixes.md). Critical fixes: security, session, data safety. | P0 | done |
| [C2](C2-psycle-api-v2.md) | Psycle API v2 compliance and efficiency | **P0** (phase 1), P1 (phase 2) | ~4–5 days |
| C3 (archived) | ✅ **FINISHED, archived 2026-10-06** — [Archive/2026-10-06/C3-multi-gym-correctness.md](../Archive/2026-10-06/C3-multi-gym-correctness.md). Multi-gym correctness; the last hunt candidate (failed fetch wiping reminder cache) fixed 2026-10-06. | P1 | done |
| [C4](C4-live-acceptance-and-launch.md) | Live acceptance, promote to prod, JAB launch | **P0 milestone** | ~3 days of work over ~1–2 weeks elapsed |
| [C5](C5-auto-book.md) | Auto-book gaps; Favourites build (P3) | P2 (Favourites P3) | ~2.5 days |
| [C6](C6-accounts-auth.md) | Accounts and auth | P2 | ~2–3 days |
| [C7](C7-platform-ops.md) | Platform, ops and security hardening | P1 (pre-launch subset), P2–P3 (rest) | ~1 day pre-launch, then ~1 week |
| [C8](C8-admin-panel-and-insights.md) | Admin panel, fleet intelligence, attendance & ops | P2 | ~1.5–2 weeks |
| [C9](C9-gym-onboarding.md) | Gym onboarding: provider reuse, tenant evidence and activation gates | P1 | Ongoing playbook |
| [C10](C10-aarmy-integration-acceptance.md) | Aarmy integration acceptance | **P0** | Outstanding live acceptance |

### UX / design

| ID | Workstream | Priority | Size |
|---|---|---|---|
| U1 (archived) | ✅ **FINISHED, archived 2026-10-06** — [Archive/2026-10-06/U1-ux-bug-fixes.md](../Archive/2026-10-06/U1-ux-bug-fixes.md) | P1–P2 | done |
| [U2](U2-components-accessibility.md) | Shared components and accessibility (U2-1, U2-2, U2-5 done; **U2-4 shared empty-state helper open**) | P2 | ~2 days |
| [U4](U4-ux-improvements.md) | UX improvements: done: U4-1..5, U4-7..9, U4-11, U4-12 (accepted), U4-13, U4-14 (closed, logo dropped), U4-15, U4-16, U4-17, U4-18, U4-2, **U4-19 (URL routing phases 1-8, built 2026-10-06, not deployed)**; U4-6 evaluated; **open: U4-10 (more glass)** | P2 | ~1–2 days (glass) |
| [U5](U5-modal-fullscreen-and-spot-flow.md) | Mobile full-screen pages and the spot-map booking flow: U5-1..U5-11, U5-13, U5-16..U5-25 done; open: U5-12 (iOS keyboard, device), U5-14, U5-15 | P2 | ~0.5 day + device check |
| [U3](U3-css-design-debt.md) | CSS and design-system debt | P3 | ~1 week |

### Later

| ID | Workstream | Priority |
|---|---|---|
| [H](H-home-page.md) | Home page of widgets (formerly F-10): H-0 history pull and H-1 shell done 2026-10-05; H-2 name flow next | P2 | ~2 weeks |
| [F](F-future-features.md) | Future features: in-app 3-D Secure, guest passes, gym-neutral favourites, social sharing, MCP server, Postgres | P2–P3 |

### Session logs

| Doc | State |
|---|---|
| [5-10-enhancements.md](5-10-enhancements.md) | Merged into `modular` 2026-10-06; U4-19 built on branch `followups-2026-10-06` (not yet merged/deployed); open: browser smoke of merged tree on the dev twin, renderer merge, search-incremental rendering |

## Recommended order

1. **C1 Critical fixes.** Small and independent. It closes a credential-leak surface and a
   bug where one gym's expired token logs you out of the whole app.
2. **C2 phase 0–1 (API capture, then v2 cart and waitlist verb).** Buy Credits is broken in prod
   today. Needs a live traffic capture first (gate G1).
3. **C3 Multi-gym correctness, with U1 alongside.** The bugs the 2026-09-23 live run found. U1
   is cheap copy/UI fixes that share the same test pass.
4. **C7 pre-launch subset.** SQLite backups, read-route rate limits, build-stamped service
   worker cache.
5. **C4 Live acceptance, promote `modular` to prod with clean DB and JAB enabled.**
   Includes user review of the `/admin` panel on the dev twin before deploy, a fresh DB
   rollout (no legacy migration debt), and multi-gym enabled at launch.
6. **C2 phase 2 (efficient reads).** `/events` v2, `/heartbeat` cache invalidation, `/profile`
   dedupe. Deliberately after launch so the upstream traffic shape changes in a separate deploy.
7. **C5 Auto-book gaps** (Favourites build last, P3), then **C6 Accounts and auth**.
8. **C10 Aarmy acceptance** only when an Aarmy activation is intended; C9 remains the standard
   onboarding path for future tenants.
9. **U2 Components and accessibility**, then **U3 CSS debt.** U3 waits until after launch because it
   touches every screen and would invalidate acceptance screenshots.
10. **F Future features**, plus the rest of C7.

Added 2026-09-29: **U4** UX improvements (after the current U1 batch, before U3), **U1-11..U1-16** (current to-do), **F-7** gym config editor, **F-8** MarianaTek profile explorer, **F-9** Gemini-powered booking/checking assistant, **F-10** Home/Dashboard page (now its own workstream, [H](H-home-page.md)), **F-11** class counts/stats/insights, **F-12** gym-neutral favourites, **F-13** calendar/weekly view of bookings, **F-14** SoulCycle gym integration, and **F-15** instructor photo proxy and cache. Added 2026-10-05: **F-16** admin-panel gym onboarding and editing (audit of per-gym config first). **F-17** instructor-change notification for any booked class, detected in the existing booking poll (spec only; see [F-future-features.md](F-future-features.md)). Added 2026-10-05: **U5** mobile full-screen pages and spot-map booking flow (progress, open items, new feedback).

Added 2026-09-27: **U2-5** (implement `TIMETABLE_FILTER_DESIGN_BRIEF.md`, after C4) and
**U3-6** (sweep for leftover "Psycle" references in gym-agnostic code, done with U3-1).

## Dependency map

```mermaid
graph LR
  C1[C1 Critical fixes] --> C4
  G1[C2 G1 live capture] --> C2a[C2 phase 1: v2 cart + waitlist]
  C2a --> C4
  C3[C3 Multi-gym correctness] --> C4
  U1[U1 UX bug fixes] -.-> C4
  C7a[C7 pre-launch: backups, rate limits, SW cache] --> C4
  C4[C4 Promote modular + JAB launch] --> C2b[C2 phase 2: efficient reads]
  C4 --> U3[U3 CSS debt]
  C2a --> F3DS[F: in-app 3-D Secure]
  U2m[U2 modal shell] --> U2f[U2 focus trap]
  U3n[U3 psycle- rename] --> U3i[U3 !important cleanup]
  C5 --> C5f[C5-2 Favourites build, P3]
```

Hard dependencies are solid arrows. U1 → C4 is dotted: nice to have, not blocking.

## Decisions

| Date | Decision |
|---|---|
| 2026-09-26 | **No prod (`master`) fix for Buy Credits.** C2 targets `modular` only. Prod in-app checkout stays broken until C4 ships `modular`. |
| 2026-09-26 | **Auto-Book Favourites will be built, at low priority** (C5-2, P3). Until then the UI stays hidden, as it is now. |
| 2026-09-26 | **Self-service account recovery uses an emailed single-use reset link** (C6-1). Needs a mail sender, which C6-2 email-change verification reuses. |

## Verified done: dropped from the backlog

These were still listed as open in the old docs. The code shows them done.

- Brand colour token: tokenised for light and dark themes, and matches `gyms.config.js`.
- Instructor thumbnails in timetable rows; gym logos and per-gym `[data-gym]` visual cues.
- Timetable paints from cache immediately on manual refresh; skeleton loaders on all tabs.
- No false "ineligible" flash while eligibility loads (`getIneligibleReason` is permissive until loaded).
- Reformer and other map studios keep "Book (choose a spot)" in the overflow menu.
- Poller booking-window tip is per-gym and provider-correct for non-CodexFit gyms.
- MarianaTek metadata catalog (`/api/metadata`) is provider-backed.
- `last_authenticated_at` is written on session issue (QA-07).
- Multi-gym Credits & Membership selector (live acceptance still sits under C4).
- `/api/proxy` deleted; account-level calendar feed; Settings restructure; filter grouping by gym;
  toast `aria-live`; QA-02 and QA-03.

## How to use this folder

- Gym integration material: [C9 — Gym onboarding](C9-gym-onboarding.md) is the authoritative
  reusable process and evidence record. [C10 — Aarmy integration acceptance](C10-aarmy-integration-acceptance.md)
  holds its P0 tenant-specific steps and does not authorise activation or deployment.

- Change status **here only**: tick the item or add a dated note. Don't revive the archived files.
- New work goes into the matching workstream. For a large design, write a spec file in this folder
  and link it from the item.
- Item IDs (`C3-4`, `U1-2`) are stable. Reference them in commits and code comments.
- The old item IDs (QA-nn, WP-xx, Dn, Qn) are kept in brackets so the archive and QA logs can be
  traced.
