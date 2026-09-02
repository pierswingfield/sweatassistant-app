# Modular Multi-Gym Refactor

Planning + execution docs for evolving the app from single-provider (CodexFit / Psycle London) into **Sweat Assistant** — a multi-gym, multi-provider assistant. **First new target: MarianaTek support for JAB Boxing Club.**

## Read in this order

1. **[PLAN.md](./PLAN.md)** — the master plan: locked decisions, rigorous analysis (UX / logic / technical / management / docs), target architecture, phased work packages, testing, risks. *Authoritative.*
2. **[AGENT_INSTRUCTIONS.md](./AGENT_INSTRUCTIONS.md)** — the multi-agent working protocol. **Read before touching code.** Golden rules, branch/commit conventions, Definition of Done, handoff template.
3. **[PROGRESS.md](./PROGRESS.md)** — the living status board: per-WP status, Handoff Log, Decisions Log, Open Questions. *Update as you work.* **Read the top status line + the newest Handoff Log entry first — that's where "what to do next" actually lives.**
4. **[LIVE_VERIFICATION_PLAYBOOK.md](./LIVE_VERIFICATION_PLAYBOOK.md)** — only needed if a task involves a real (non-mock) CodexFit or MarianaTek request. Safety rules + a pre-authorized, risk-tiered action list for the current Open Questions.

## Supporting research (elsewhere)

- [../../Services/marianatek.md](../../Services/marianatek.md) — MarianaTek platform + live JAB API research (auth flow, endpoints, schemas).
- [../../Services/psycle_codexfit.md](../../Services/psycle_codexfit.md) — CodexFit gotchas.
- [../sweat_assistant_modular_gyms.md](../sweat_assistant_modular_gyms.md) — original high-level spec (superseded by this folder; kept for reference).

## One-line status

**Server-side is essentially done and heavily tested.** Phases 0 (MT research), 1 (provider abstraction), 2 (multi-gym schema), 3 (normalized API + all background services on the adapter), and 4 (MarianaTek adapter) are complete. 6 committed test suites cover both providers (adapters, MT mock integration, poller auto-upgrade, calendar feed, Psycle regression, auth/crypto) — see PROGRESS.md's Phase 7 row. **Phase 5 (client refactor) is next and in progress**: the normalized client API surface exists (`client/src/api.js`) but no UI module calls it yet — see the newest PROGRESS.md Handoff Log entry for the exact next step (browser-verified UI migration, timetable first). Browser verification is available in-session via Claude for Chrome as of 2026-07-03.
