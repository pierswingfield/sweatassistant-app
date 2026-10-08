# C9 — Gym onboarding

**Priority:** P1 · **Depends on:** C3, F-7 presentation contract · **Blocks:** safe repeatable
tenant activation and any future UI-driven onboarding

> **Verify first:** follow [AGENT_PROTOCOL.md](AGENT_PROTOCOL.md). Live-account checks follow
> [LIVE_VERIFICATION_PLAYBOOK.md](../LIVE_VERIFICATION_PLAYBOOK.md); no write is implied by
> this workstream.

## Purpose and boundary

This is the single onboarding playbook and evidence record for gyms that use an existing
provider adapter. The architecture has three layers: a platform adapter owns its protocol;
`server/gyms.config.js` owns tenant endpoints, policy, capabilities and presentation; callers
above `providers/` consume normalized data. Do not add gym-name branches above `providers/` or
force CodexFit and MarianaTek into one raw API shape.

CodexFit and MarianaTek share this modular boundary. MarianaTek is particularly tenant-ready
because its adapter reads `this.gym` for URLs and headers; its OAuth/PKCE, payment-option and
per-class-release protocol remains intentionally distinct from CodexFit's profile/cart/window
protocol.

## Existing reusable materials

| Resource | Purpose |
|---|---|
| `server/gyms.config.js` | Registry, validation, tenant wiring, policy, capabilities and presentation. |
| `server/providers/base.js`, `normalize.js`, `index.js` | Provider contract, normalized shapes and gym-ID provider resolution. |
| `server/providers/codexfit.js`, `marianatek.js` | Platform protocol implementations. |
| `server/mock*.js`, `server/test-*-mock.js` | No-balance state-transition coverage. |
| `Documentation/Services/*.md` | Sanitised platform captures, facts and unknowns. |
| `TESTING.md`, `test-gym-isolation.js`, `test-no-gym-privilege.js` | Regression, isolation and anti-hardcoding gates. |

## Standard onboarding procedure

1. **Identify and scope.** Record public site, booking tenant/subdomain, timezone, locations,
   assets, intended activation state and a test account. Establish provider compatibility from
   authenticated read traffic and browser assets; a matching brand alone is insufficient.
2. **Capture safe evidence.** Save only sanitised responses proving login/renewal, profile,
   timetable, event details/layout, availability, bookings/waitlists, credits or membership and
   booking release. Never retain credentials or tokens.
3. **Choose adapter.** Reuse an adapter only if auth and read flows fit. Otherwise add a platform
   adapter implementing `GymProvider`; do not make an existing adapter tenant-specific.
4. **Configure one tenant entry.** Set ID, provider, timezone, endpoints, client-fidelity
   headers, a development mock identity, default-off production gate, theme/presentation/assets,
   labels/aliases, observed capabilities and booking policy. Store assets in
   `client/public/gyms/`.
5. **Prove normalized wiring.** Confirm `getProvider(gymId)`, gym-qualified events, normalized
   event/slot/release fields and platform variants. MarianaTek requires separate pick-a-spot and
   FCFS checks; FCFS must produce no layout slots. Resolve payment options before any mutation.
6. **Verify.** Run targeted provider/mock, isolation and no-gym-privilege suites under Node 20,
   then relevant client tests/build. Run mutable mocks serially. In real Chrome, clear caches and
   confirm branding and live read data.
7. **Activate separately.** Record read acceptance, policy evidence and explicitly authorised
   write coverage (or a waiver), then obtain a production enable/deploy decision and repeat the
   target-environment browser check. An enable variable is never acceptance by itself.
8. **Warm instructor photos.** After adding or enabling a gym on a deployed environment, run
   `docker exec <container> node server/scripts/warm-instructor-photos.js` (all enabled gyms) or
   `... warm-instructor-photos.js --gym <gymId>` (one gym, e.g. `--gym aarmy`) so photos are
   cached before first use. Exit code 1 means some photos failed; the failures are listed.

## Required evidence and acceptance

- Platform/tenant identity, authentication and renewal are evidenced by live reads.
- Each configured capability is observed or explicitly marked unproven; client actions are gated
  by capability plus tenant evidence.
- Every tenant returns normalized events/details with its `gymId`; no source path contains a
  hardcoded gym ID, hostname or presentation name.
- Booking release is preserved from the platform where published. A fallback must be tenant
  evidenced; missing release must never be treated as immediately bookable.
- Mock coverage proves provider state transitions; live mutation coverage is separately
  authorised and recorded. Browser acceptance follows cache clearing.

## Aarmy reference trial — 2026-09-30

Aarmy was identified as a MarianaTek tenant at `mt.aarmy.com` and configured as `aarmy` with
New York timezone, Aarmy presentation assets, per-class release and a production-off
`AARMY_ENABLED` gate. The shared adapter's JAB-only development identity was replaced by the
tenant configuration seam `gym.mockEmail`.

Read-only evidence passed: OAuth login, normalized profile/identity, session refresh, credits,
membership, timetable/locations, published release time, class detail/layout, bookings and
waitlists. Chrome CDP showed Aarmy in the gym flow and loaded both assets. Node 20 MarianaTek
mock coverage passed 13/13; the integration run reported 57 server suites, 25 client test files
(188 tests), and the production client build passing.

The mock fixture remains JAB-shaped and is not Aarmy data. No live Aarmy booking, cancellation,
waitlist mutation, swap, checkout, payment or penalty check ran; the user waived those checks,
and Aarmy is enabled in production. Its acceptance record is archived at
[C10 — Aarmy integration acceptance](../Archive/2026-10-08/C10-aarmy-integration-acceptance.md).

## Findings and planned improvements

| Priority | Confirmed finding or risk | Change | Acceptance evidence |
|---|---|---|---|
| P0 | A shared MarianaTek mock was JAB-email-specific. | Keep `gym.mockEmail`; add registry contract coverage for each enabled development tenant. | Multiple tenants use the shared mock without adapter edits. |
| P0 | A live tenant's write/payment/penalty behaviour cannot be inferred from mock paths. | Maintain per-tenant capability/evidence records and gate actions on both. | Sanitised capture plus authorised safe test, or explicit waiver. |
| P1 | A continuous fallback can misrelease a class if `booking_start_datetime` is absent. | Validate per tenant; correct/remove the fallback, or make release unresolved. | Capture and policy regression test. |
| P1 | MarianaTek metadata is inferred from active classes. | Specify quiet/empty-timetable behaviour; use a dedicated provider endpoint only if authoritative. | Behaviour test for an empty or sparse schedule. |
| P1 | Registry and asset changes are still source edits. | Build the F-7 validated admin draft/preview/activation flow; secrets stay outside its schema. | Invalid draft rejected; preview branded; activation needs evidence. |
| P2 | Unseen provider variants can differ by tenant. | Add sanitised tenant fixtures only where a live shape differs; keep shared normalized contract tests. | Variant fixture reproduces and protects a confirmed difference. |
