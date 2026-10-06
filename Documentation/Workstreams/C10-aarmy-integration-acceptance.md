# C10 — Aarmy integration acceptance

> **2026-10-06: Aarmy ENABLED in prod by user decision** (`AARMY_ENABLED=true`), before C10 acceptance. C10-5 (the activation decision) is therefore made. C10-1 (rotate the test account password), C10-2 (write-mutation policy), C10-3 (release-time fallback validation) and C10-4 (acceptance on the target environment, now prod) are **still open and now concern live users**: do them next, read-only first.


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

- [ ] Password rotation is recorded without storing the secret.
- [ ] Each mutation is passed with evidence or consciously waived.
- [ ] The fallback policy is evidenced and protected by a test.
- [ ] Target-environment Chrome acceptance passes after cache clearing.
- [ ] Production enablement is explicitly approved, deployed and rechecked.
