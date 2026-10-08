# C10 — Aarmy integration acceptance

> **Current status (2026-10-08):** Aarmy is enabled in prod by user decision (`AARMY_ENABLED=true`). C10-1 password rotation is done; C10-2 write-path tests and C10-4 target-environment acceptance were waived by the user. C10-3 release-time fallback validation is explicitly deferred; the provisional 14-day fallback remains until then. C10-5 activation is complete.
>
> **CLOSED and archived 2026-10-08.** Remaining fallback validation is deferred by user decision and is not a blocker for this completed integration acceptance.


**Priority:** P0 · **Depends on:** C9 · **Blocks:** enabling or deploying Aarmy

Follow [AGENT_PROTOCOL.md](../../Workstreams/AGENT_PROTOCOL.md) and
[LIVE_VERIFICATION_PLAYBOOK.md](../../LIVE_VERIFICATION_PLAYBOOK.md) for any future acceptance work.

## Verified evidence

- Aarmy is a MarianaTek tenant; the `aarmy` registry entry, shared adapter, presentation assets
  and production-off gate exist.
- Live reads passed for OAuth login/refresh, normalized profile, credits, membership, timetable,
  locations, release time, event detail/layout, bookings and waitlists.
- Real Chrome CDP showed the linked Aarmy gym and its assets. Mock provider coverage passed;
  broader integration validation is recorded in [C9](../../Workstreams/C9-gym-onboarding.md).

## Deferred follow-up

1. **Validate booking release fallback (deferred by user).** Confirm Aarmy's policy when
   `booking_start_datetime` is absent. Change/remove the provisional 14-day fallback if evidence
   differs; add a regression test for the confirmed rule.

## Done when

- [x] Password rotation is recorded without storing the secret (user, 2026-10-06).
- [x] Each mutation consciously waived by the user (2026-10-06); first real Aarmy booking to be watched.
- [ ] The fallback policy is evidenced and protected by a test. **Deferred by the user (2026-10-06).**
- [x] Target-environment Chrome acceptance: **waived by the user 2026-10-06** (works on dev).
- [x] Production enablement approved by the user and rechecked (`/api/gyms` in the prod container: aarmy enabled, `/api/health` ok), 2026-10-06.
