# C10 — Aarmy integration acceptance

> **2026-10-06: Aarmy ENABLED in prod by user decision** (`AARMY_ENABLED=true`), before C10 acceptance, so C10-5 (activation) is made. User updates, same day: **C10-1 password rotation DONE** (per user, secret not recorded); **C10-3 release-time fallback DEFERRED** ("later"; the provisional 14-day fallback stays until validated, so a per-class `booking_start_datetime` is read when present and the fallback only applies when it is absent); **C10-4 target-environment acceptance WAIVED** (user is satisfied from the dev twin, where it works); **C10-2 write-path scope: WAIVED by the user** (no live booking, cancel, waitlist, swap, checkout, payment or penalty tests on Aarmy; covered by mock tests and by JAB's live-proven MarianaTek write paths; the first real Aarmy booking is the de facto test, so watch it).


**Priority:** P0 · **Depends on:** C9 · **Blocks:** enabling or deploying Aarmy

> **Current status:** read-only onboarding passed on 2026-09-30; Aarmy remains disabled in
> production and has not been deployed. Follow [AGENT_PROTOCOL.md](AGENT_PROTOCOL.md) and
> [LIVE_VERIFICATION_PLAYBOOK.md](../LIVE_VERIFICATION_PLAYBOOK.md).

## Verified evidence

- Aarmy is a MarianaTek tenant; the `aarmy` registry entry, shared adapter, presentation assets
  and production-off gate exist.
- Live reads passed for OAuth login/refresh, normalized profile, credits, membership, timetable,
  locations, release time, event detail/layout, bookings and waitlists.
- Real Chrome CDP showed the linked Aarmy gym and its assets. Mock provider coverage passed;
  broader integration validation is recorded in [C9](C9-gym-onboarding.md).

## P0 outstanding steps

1. **Rotate the test-account password.** Credential input was echoed to a PTY transcript during
   the read-only session. Use a non-echoing input route thereafter; do not place the value in any
   repository file, command, issue or documentation.
2. **Decide the write-path scope.** Explicitly authorise narrowly safe, reversible tests or
   record each as waived: booking, cancellation, waitlist join/leave, spot swap, checkout,
   payment and penalty handling. Inventory bookings, waitlists and credits before and after.
3. **Validate booking release fallback.** Confirm Aarmy's policy when
   `booking_start_datetime` is absent. Change/remove the provisional 14-day fallback if evidence
   differs; add a regression test for the confirmed rule.
4. **Target-environment acceptance.** After any authorised deployment, clear service worker,
   CacheStorage and IndexedDB; repeat the real-Chrome Aarmy read check and capture evidence.
5. **Activation decision.** Obtain an explicit production enable/deploy decision only after the
   preceding records exist. `AARMY_ENABLED=true` alone is insufficient.

## Done when

- [x] Password rotation is recorded without storing the secret (user, 2026-10-06).
- [x] Each mutation consciously waived by the user (2026-10-06); first real Aarmy booking to be watched.
- [ ] The fallback policy is evidenced and protected by a test. **Deferred by the user (2026-10-06).**
- [x] Target-environment Chrome acceptance: **waived by the user 2026-10-06** (works on dev).
- [x] Production enablement approved by the user and rechecked (`/api/gyms` in the prod container: aarmy enabled, `/api/health` ok), 2026-10-06.
