# C4 — Live acceptance, promote `modular` to prod, JAB launch

**Priority:** P0 milestone · **Size:** ~3 days of hands-on work, ~1–2 weeks elapsed (some checks
wait for real release windows and penalty windows)
**Depends on:** C1, C2 phase 1, C3, C7 pre-launch subset · **Blocks:** C2 phase 2, U3, most of F

> **Verify first:** before changing anything for an item, confirm its basis in the code **and**, for anything user-visible, **in a real browser** (CDP :9222 or Claude for Chrome). For server-only items, use a failing test or a request. Record the evidence. If a browser check is needed and no browser is available, stop with `BLOCKED`. See [AGENT_PROTOCOL.md](AGENT_PROTOCOL.md).

Prod runs the old single-gym `master`. The dev twin runs `modular`. The mechanical suites are
green, and most of the live matrix passed on 2026-09-15 and 09-23. This workstream closes the
remaining live checks, ships `modular` to prod, and then turns JAB on.

Rules for live testing: [`LIVE_VERIFICATION_PLAYBOOK.md`](../LIVE_VERIFICATION_PLAYBOOK.md).
Flow matrix: [`QA/USER_FLOW_VALIDATION_PLAN.md`](../QA/USER_FLOW_VALIDATION_PLAN.md).
Prior results: [`QA/browser-runs/`](../QA/browser-runs/).

## Stage A — Remaining live verification (dev twin)

| # | Check | Why it's still open | Est. |
|---|---|---|---|
| C4-1 | **Unattended future Auto-Book fires at a real release** (Psycle Monday release and a JAB rolling window) | Only verified while someone was watching | wait for a release |
| C4-2 | MarianaTek **cancel inside the penalty window**: confirm the penalty warning and the actual outcome | Never exercised live [Q9] | 1 h + a booking |
| C4-3 | MarianaTek **auto-upgrade cutoff** matches the real penalty boundary | Cutoff is assumed, not measured [Q9] | 1 h |
| C4-4 | MarianaTek **native waitlist auto-fill** doesn't fight the app's own waitlist handling | Unknown interaction [Q7] | needs a full class |
| C4-5 | **Colliding provider IDs** across gyms (same event or location ID at Psycle and JAB) | Mock-tested only | 1 h |
| C4-6 | **Fresh account onboarding** end to end, including linking a second gym | Done piecemeal, never on a clean account | 1 h |
| C4-7 | **Installed PWA** on iOS: layout, offline, and push delivery for both gyms | Browser only so far | 1 h |
| C4-8 | **Calendar feed on a real phone**: one `.ics` spanning both gyms | Desktop only | 30 min |
| C4-9 | **Credits & Membership** tab live acceptance for both gyms (after C2-1) | Built 2026-09-12, never accepted live | 1 h |
| C4-10 | **Psycle regression** after C2 phase 1: `test-regression-psycle.js` plus a live book, cancel and waitlist cycle | New cart and waitlist code | 1 h |

## Stage B — Promote to prod

| # | Step |
|---|---|
| C4-11 | Back up the prod DB **with WAL** (or run C1-5's job). Record a rollback path: the previous image tag, with the Pi standby container kept. |
| C4-12 | Dry-run the modular migrations against a **copy** of the prod DB (`user_gyms` backfill, calendar-to-account-scope, gym-scoped tables). Check row counts before and after. |
| C4-13 | Deploy `modular` to `psycle-app` with **JAB disabled** (`JAB_BOXING_ENABLED` unset). Prod users should see no functional change apart from the new UI. Clear all three client caches when verifying (SW, IndexedDB, hard reload). |
| C4-14 | Soak for a few days, covering at least one Psycle Monday release with real auto-books. |

## Stage C — Enable JAB

| # | Step |
|---|---|
| C4-15 | Set `JAB_BOXING_ENABLED=true` in prod, or make `enabled: true` the config default. `gyms.config.js` ~L125 is still env-gated. |
| C4-16 | Update `AGENTS.md` status, the service registry, and this folder. [WP-T4, WP-X1] |

## Done when

- [ ] All Stage A rows pass or are consciously waived (write the reason here).
- [ ] Prod runs `modular`; one Psycle release cycle passed with no regressions.
- [ ] JAB enabled in prod, with at least one real JAB booking made through prod.
