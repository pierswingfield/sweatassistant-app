# Modular Multi-Gym Refactor

Planning + execution docs for evolving the app from single-provider (CodexFit / Psycle London) into **Sweat Assistant** — a multi-gym, multi-provider assistant. **First new target: MarianaTek support for JAB Boxing Club.**

## Read in this order

1. **[OUTSTANDING.md](./OUTSTANDING.md)** — current state, acceptance gates and build order. *Authoritative for what happens next.*
2. **[PLAN.md](./PLAN.md)** — original master plan and locked architecture decisions.
3. **[AGENT_INSTRUCTIONS.md](./AGENT_INSTRUCTIONS.md)** — working protocol, Definition of Done and handoff format.
4. **[PROGRESS.md](./PROGRESS.md)** — historical per-work-package status, handoffs, decisions and open questions.
5. **[LIVE_VERIFICATION_PLAYBOOK.md](./LIVE_VERIFICATION_PLAYBOOK.md)** — safety rules for real CodexFit or MarianaTek requests.
6. **[ARCHIVE-2026-09-02.md](./ARCHIVE-2026-09-02.md)** — superseded readiness snapshot; historical only.

## Supporting research (elsewhere)

- [../../Services/marianatek.md](../../Services/marianatek.md) — MarianaTek platform + live JAB API research (auth flow, endpoints, schemas).
- [../../Services/psycle_codexfit.md](../../Services/psycle_codexfit.md) — CodexFit gotchas.
- [../sweat_assistant_modular_gyms.md](../sweat_assistant_modular_gyms.md) — original high-level spec (superseded by this folder; kept for reference).

## One-line status

The modular server and merged multi-gym client are implemented in the current worktree. The next
product build is the remaining visual-system cleanup (card typography first). Production readiness
is still gated by live multi-gym/JAB/Psycle acceptance; nothing in the current worktree has been
deployed as part of this handoff.
