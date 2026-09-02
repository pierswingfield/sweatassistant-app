# Agent Instructions — Modular Multi-Gym Refactor

> Read this **before touching any code** for the modular-gyms work. It exists so any agent can pick up where the last one left off without re-deriving context or breaking Psycle.

---

## 0. TL;DR startup ritual (do this every session)

1. **Read** [PLAN.md](./PLAN.md) §0 (locked decisions), §3 (architecture), §4 (your phase/WP).
2. **Read** [PROGRESS.md](./PROGRESS.md) — the status board, the **latest Handoff Log entry**, Open Questions, and the Decisions Log.
3. **Pick** the next `Not started` WP whose dependencies are all `Done` (or continue an `In progress` WP you own). Respect phase order.
4. **Claim it:** set its row to `In progress`, put your agent id + date, and note the branch you'll use.
5. **Do the work** to the WP's acceptance criteria in PLAN.md §4.
6. **Verify:** run the relevant tests; **Psycle regression (WP-T3) must stay green** from Phase 1 onward.
7. **Close out:** set status (`Done` / `Blocked` / `In review`), update the touch-list, and **append a Handoff Log entry** (template below).

If you cannot finish, still leave the WP in a clean, documented state with a handoff note describing exactly what remains.

---

## 1. Golden rules (do not violate)

1. **Never regress Psycle.** Psycle London is live. Every phase boundary must leave Psycle fully working. Phase 1 extraction is **behavior-preserving** — identical payloads, identical timing.
2. **Never cancel a real paid booking** on any live account. MarianaTek does **not** return credit on cancel (research §1F). Test writes only on the authorized JAB test account (`aiproscw@gmail.com` / Sebastian Clearwater, user 60623), and keep destructive calls behind an explicit guard.
3. **Keep dev mocks working.** `dev@psycle.com` (CodexFit mock) must keep working; add/maintain the MT mock for the JAB dev path. The full UI must run offline for both providers.
4. **Respect the locked decisions** (PLAN.md §0: multi-gym-per-account, "Sweat Assistant" branding, full-parity-minus-purchases). To change one, add a Decisions Log entry and flag the stakeholder — don't silently diverge.
5. **One WP per branch.** Keep changes scoped to your WP's touch-list to avoid multi-agent merge conflicts. Integrate into `modular`.
6. **Don't guess the API.** Use captured fixtures (WP-R3) and the research doc. If a field mapping is unknown, mark it an Open Question — don't invent shapes.
7. **Timezone math** stays in `Europe/London` via Luxon (server + client `lib.js`). Never bare `new Date()` for booking windows.
8. **Never make a live request against a real CodexFit or MarianaTek server (not mock, not fixture) without reading [LIVE_VERIFICATION_PLAYBOOK.md](./LIVE_VERIFICATION_PLAYBOOK.md) first and getting the user's explicit go-ahead for that specific action.** This applies even to safe, read-only, unauthenticated GETs — the rule is about transparency (the user should always know when an agent is about to hit a real third-party service on their behalf), not just risk. The playbook has a pre-built, risk-tiered action list for the current Open Questions — use it rather than improvising a new live check.

---

## 2. Branch & commit conventions

- Integration branch: **`modular`** (already checked out).
- Per-WP branch: `modular/wp-XX-short-slug` (e.g. `modular/wp-a3-extract-codexfit`).
- Commit style: `feat(providers): extract CodexFit auth into adapter [WP-A3]` — include the WP id.
- Merge WP branch → `modular` when its AC are met + regression green. `modular` → `master` only at a tested phase boundary, and only when the phase's WPs are `Done`.
- **Commit/push only when the task explicitly calls for it or the user asks.** Otherwise leave work staged and describe it in the handoff.
- End commit messages with the `Co-Authored-By` trailer per repo convention.

---

## 3. Definition of Done (per WP)

A WP is `Done` only when **all** hold:

- [ ] Acceptance criteria in PLAN.md §4 are met.
- [ ] Code matches surrounding style (the codebase inlines a lot; match local idiom, don't crusade).
- [ ] Tests added/updated (unit for adapters/normalization; integration where a flow changed).
- [ ] **Psycle regression (WP-T3) green** (from Phase 1 onward).
- [ ] Dev mocks still work for both providers (where applicable).
- [ ] PROGRESS.md row updated (status, owner, date, touch-list, verification note).
- [ ] Handoff Log entry appended.
- [ ] Any new unknown → Open Questions; any new decision → Decisions Log.

---

## 4. Handoff Log entry template

Append to the top of the Handoff Log in [PROGRESS.md](./PROGRESS.md) (newest first):

```markdown
### <YYYY-MM-DD> · <agent id> · WP-XX <title>
- **Status:** In progress | Done | Blocked | In review
- **Did:** <what you actually changed — files, key decisions>
- **Verified:** <tests run + result; Psycle regression state>
- **Next:** <the very next concrete step for whoever picks this up>
- **Gotchas:** <traps, surprises, fixture quirks, anything non-obvious>
- **Touched:** <file list>
```

Keep "Next" concrete enough that a cold agent can act on it without reading your mind.

---

## 5. Where things live

| Need | Location |
|------|----------|
| The plan / phases / WP acceptance criteria | [PLAN.md](./PLAN.md) |
| Live status board + handoff + decisions | [PROGRESS.md](./PROGRESS.md) |
| MarianaTek API research (auth, endpoints, schemas, JAB specifics) | [../../Services/marianatek.md](../../Services/marianatek.md) |
| CodexFit gotchas | [../../Services/psycle_codexfit.md](../../Services/psycle_codexfit.md) |
| Original modular spec (superseded by this folder) | [../sweat_assistant_modular_gyms.md](../sweat_assistant_modular_gyms.md) |
| Design system | [../../DESIGN.md](../../DESIGN.md) |
| Project overview / architecture constraints | [../../../AGENTS.md](../../../AGENTS.md) |
| MT fixtures (once captured) | `server/__fixtures__/marianatek/` |
| Safety plan for any live (non-mock) API request | [LIVE_VERIFICATION_PLAYBOOK.md](./LIVE_VERIFICATION_PLAYBOOK.md) — read before Golden Rule 8 applies |

---

## 6. Escalate to the stakeholder when…

- A locked decision (PLAN.md §0) needs to change.
- A Phase 0 research unknown resolves in a way that blocks a WP (e.g. MT write path unavailable).
- A change would alter Psycle's observable behavior.
- You need live-write access to a real account beyond the JAB test account, or any live request the [Live Verification Playbook](./LIVE_VERIFICATION_PLAYBOOK.md) doesn't already cover with a pre-authorized action.

Record the escalation in Open Questions and, if it's a real user decision, surface it directly rather than assuming a default.

---

## 7. Verifying the real app

- **Claude for Chrome (`mcp__Claude_in_Chrome__*` tools) is available in this environment as of 2026-07-03** — the earlier assumption in older handoff notes ("browser verification not reachable from here") is **no longer true**. Use it for any UI-facing WP (Phase 5 client refactor especially) rather than deferring browser checks to "a future pass." Run `npm run dev` (or `npm run dev:client` against the already-running dev server) and drive `localhost:5173` via the extension; log in as `dev@psycle.com` (any password) for the CodexFit mock.
- `/run` skill to launch the PWA; `/verify` to confirm a change works end-to-end — prefer these over ad-hoc Chrome-tool driving when they cover the scenario, since they're purpose-built for this.
- After any deploy, **clear the service worker** or the browser serves stale JS ([[prod-deploy-cache-gotcha]]); verify against the Pi LAN origin.
- `styles.css` is the only stylesheet that renders; `panel-layout.css` is dead ([[panel-layout-css-dead]]).
- **This is dev-mode/localhost verification, not a live third-party request** — Golden Rule 8 / the Live Verification Playbook don't apply to driving the local dev server's UI, only to requests that leave the machine toward a real CodexFit/MarianaTek server.
- There are **two** floor-plan renderers ([[two-floor-plan-renderers]]) — WP-C5 addresses consolidating/normalizing them.
