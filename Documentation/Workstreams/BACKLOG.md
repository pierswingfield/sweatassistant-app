# Backlog

This is the single home for deferred, low-priority, research-first, and user-dependent work. Items here are not active commitments. Stable IDs remain unchanged so historical notes and code references stay traceable.

## Product, accounts, and automation

- **C5-2 — Auto-Book Favourites.** Build queue rules from gym-neutral favourites. Low priority (P3); unblocked by F-12. Detail: [archived C5 plan](../Archive/2026-10-08/C5-auto-book.md).
- **C6-1 — Emailed password reset.** Add a transactional email sender and single-use reset flow; no real users yet, so deferred. **C6-2 — Change account email** with address verification shares the mail sender. Detail: [archived C6 plan](../Archive/2026-10-08/C6-accounts-auth.md).
- **F-1 — In-app 3-D Secure checkout.** Confirm payment in app with Stripe.js; depends on the v2 cart and live payment evidence.
- **F-3 — Social class sharing.** Weekly schedule export is done; handles, friend graph, “who's going”, and iCal enrichment remain.
- **F-4 — MCP server** for timetable queries and booking actions.
- **F-5 — MarianaTek credit-purchase research:** cart authentication and payment-option shapes.
- **F-6 — Observe MarianaTek refresh-token hard-expiry behavior** in production.
- **F-8 — MarianaTek profile explorer.** Expose useful normalized account details for diagnosis.
- **F-9 — Gemini booking/checking assistant,** with explicit user confirmation and safety gates.
- **F-13 — Weekly bookings calendar** across linked gyms.
- **F-14 — SoulCycle provider integration.** Research and implement a separate provider adapter.
- **F-16 — Admin gym onboarding/editor** after auditing which per-gym settings are safe to manage.
- **F-17 — Instructor-change notification.** Spec exists; detect changes in the booking poll and notify the member.

## Admin, operations, and tenant expansion

- **C4-2 — JAB penalty-window cancellation behavior.** User-dependent; test only when a real penalty-window event occurs naturally. Not a launch blocker.
- **C4-3 — JAB Auto-Upgrade cutoff vs the real penalty boundary.** User-dependent observation; not a launch blocker.
- **C10-3 — Aarmy release-time fallback validation.** Explicitly deferred by the user; the provisional 14-day fallback remains. See [archived C10 acceptance](../Archive/2026-10-08/C10-aarmy-integration-acceptance.md).
- **C7-5 — Per-user AES keys.** Deprioritized; current design is acceptable unless isolation requirements change.
- **C7-3 optional logging cleanup.** The audit log, JSON logger, and `/metrics` are complete; migrating the remaining free-text `console.*` calls was left as later cleanup (122 remained in the 2026-10-06 snapshot).
- **C7-6 — SQLite to Postgres.** Not needed at current scale.
- **C7-7 — Proactive occupancy-warming poller.** Re-evaluate only if the five-minute occupancy staleness becomes a user problem.
- **C7-9 — Optional legacy Psycle-named infrastructure cleanup.** Access apps were deliberately left unchanged; revisit only if needed.
- **C8-2 — Feature-usage analytics engine.** Privacy-preserving product analytics and admin view.
- **C8-3 — Live cross-gym class/attendance view** with filters and spot-map context.
- **C8-4 — Cross-gym user-usage intelligence** (habits, credits, Auto-Book/Upgrade outcomes, relogin health).
- **C8-5 — Per-gym fleet analytics** (demand, provider latency, rate limits).
- **C8-6 — Operational diagnostics/release view** (release monitor, push tester, guarded actions).
- **C8-7 — Batch operations and pre-flight fleet sweeps.** Details for C8-2..7: [archived C8 design](../Archive/2026-10-08/C8-admin-panel-and-insights.md).
- **F-7 — Gym presentation/onboarding contract follow-ups:** F-7-o1 mock a display alias; F-7-o2 missing-release queue row; F-7-o3 third-gym end-to-end fixture; F-7-o4 wordmark upload; F-7-o5 document that connection test does not verify login. See [archived F feature plan](../Archive/2026-10-08/F-future-features.md).

## UX and design-system maintenance

- **U2-4 — Shared empty-state renderer.** Low-priority maintenance to reduce duplicate markup; not a current UX issue. See [archived U2 plan](../Archive/2026-10-08/U2-components-accessibility.md).
- **U3-1..U3-6 — CSS/design-system cleanup:** remove remaining `psycle-` naming, reduce `!important`, use type tokens, move inline styles to classes, consolidate card typography, and finish the gym-neutral copy/key audit. The dead-rule cleanup is done; the remaining work is broad and low priority. See [CSS debt audit](../Audits/css-debt-audit.md) and [archived U3 plan](../Archive/2026-10-08/U3-css-design-debt.md).
- **U4-10 — More glass styling.** Visual polish; defer behind functional work. See [archived U4 plan](../Archive/2026-10-08/U4-ux-improvements.md).
