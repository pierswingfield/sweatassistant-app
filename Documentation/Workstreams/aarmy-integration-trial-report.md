# Aarmy integration trial report — 2026-09-30

**Result: integration pass for read-only onboarding; activation remains gated.** Aarmy is a
separate MarianaTek tenant. The supplied public booking subdomain resolves to the MarianaTek
tenant configured as `aarmy.marianatek.com`; no new adapter was required.

This report records the current trial evidence. It deliberately omits credentials, tokens and
raw account responses.

## Changes in the isolated worktree

| Area | Evidence | Outcome |
|---|---|---|
| Tenant registry | `server/gyms.config.js` | Added `aarmy`: MarianaTek endpoints, New York timezone, presentation/theme, `per-class` booking-window policy, capability declarations and a production-off `AARMY_ENABLED` gate. |
| Presentation assets | `client/public/gyms/aarmy-logo.png`, `client/public/gyms/aarmy-mark.png` | Full and compact/mark logo paths are supplied through Aarmy's `presentation.wordmark` config. |
| Shared adapter | `server/providers/marianatek.js` | Replaced the JAB-only mock identity constant with the configured `gym.mockEmail` seam. Live protocol wiring remains shared. |
| Regression coverage | `server/test-marianatek-mock.js` | Added Aarmy provider resolution, mock login, gym-qualified timetable and `releaseAt` assertions. |

## Read-only verification

### Local mock and browser

- The shared MarianaTek mock linked the configured Aarmy tenant and returned Aarmy-qualified
  events. The real Chrome CDP check showed Aarmy in the gym flow and loaded both Aarmy assets.
- Node 20 `server/test-marianatek-mock.js`: **13/13 checks passed**. This includes timetable,
  layouts, mock booking/cancel/waitlist/swap state transitions and membership/credits; only the
  first four assertions are specific to the new Aarmy config. The underlying data fixture is
  still JAB-shaped and is not evidence of Aarmy live data.
- Full validation reported by the integration run: **57 server suites passed; 25 client test
  files / 188 tests passed; client production build passed.**

### Live Aarmy API

The real account passed paced, sequential read-only checks through the Aarmy MarianaTek tenant:

- OAuth login, profile/normalized identity and session refresh.
- Credits, membership, timetable and locations.
- Published per-class booking release timestamp.
- Class details and layout, bookings and waitlists.

No rate-limit or WAF stop was observed. These checks establish compatibility with the existing
MarianaTek provider on the exercised read paths. They do not establish the correctness of every
unseen class/payment/layout variant.

## Explicitly untested

No live booking, cancellation, waitlist join/leave, spot swap, checkout, penalty-status or
payment action was attempted. No existing booking was available for a penalty inspection.
The mock covers several of these transitions, but a mock must not be treated as a live tenant
write-path acceptance result.

## Security follow-up

Rotate the Aarmy test-account password before any further use. A PTY transcript echoed the
credential input during the live read-only session. Do not copy it into source, fixtures,
documentation, test commands or issue comments.

## Activation gate

Aarmy is disabled in production by default and has not been deployed or enabled. Before
activation, record an authorised safe write-path plan (or explicitly waive each write path),
confirm the per-class fallback policy against live evidence, repeat the real-Chrome check on the
target environment after cache clearing, and obtain a separate production deployment/enable
decision. See the reusable [gym onboarding playbook](gym-onboarding-playbook.md) and
[live verification playbook](../LIVE_VERIFICATION_PLAYBOOK.md).

## Gaps and recommendations

| Priority | Finding | Required next action |
|---|---|---|
| P0 | The test secret appeared in a PTY transcript. | Rotate it now and use a non-echoing credential input path for future sessions. |
| P0 | Live mutations and payment/penalty behaviour are unverified. | Keep Aarmy disabled; arrange narrowly authorised, reversible write checks before making these actions available. |
| P1 | The 14-day fallback applies only when MarianaTek omits its release timestamp. | Capture an omission or obtain tenant policy evidence; change/remove the fallback if it differs. |
| P1 | The mock uses JAB-shaped data. | Add sanitised Aarmy fixtures only when their live shapes materially differ; retain normalized contract tests for shared behaviour. |
| P1 | New-tenant onboarding still requires source config and asset files. | Build a validated admin draft/preview and explicit activation workflow; keep secrets outside its schema. |
