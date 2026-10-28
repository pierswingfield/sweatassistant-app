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

## End-to-end tenant coverage matrix

Use this matrix for every new tenant, including a tenant on an existing platform. Record
evidence, an explicit waiver, or an open blocker for each applicable row; an adapter passing
its shared tests does not establish that a tenant supports the same features or policies.
Public research and live API verification must follow the live verification playbook. Never
include tokens, credentials or personal data in the record.

| Surface | Checks before acceptance |
|---|---|
| Identity and access | Official site and tenant identity; regional scope, login, renewal, gym linking, reauthentication, unlinking and no-gym state. Check that accounts and sessions stay isolated. |
| Catalogue and presentation | Registry name, short name, URLs, timezone, location zones, colours, light/dark contrast, full/compact/mark assets and accessible alternative text. Confirm all assets load on desktop and mobile. Keep tenant facts in gym configuration and assets, not product core. |
| Marketing and onboarding | Landing-page gym representation and links, gym selection and connect flow, first-run onboarding, capability-dependent copy and unlinked/disabled states. |
| Home | Widgets, gym labels and logos, filtering, empty/loading/error states and navigation to the relevant class or feature. |
| Timetable and discovery | Date/location/studio/instructor filters, search, favourites, gym selection, merged schedules, timezone/DST, class details, occupancy, release time, availability, floor plans and empty or sparse schedules. |
| Booking lifecycle | Capability-gated booking, spots and swaps, waitlist join/leave, cancellation, bookings list and error states. Exercise state transitions on mocks; live writes require the playbook's specific approval or a documented waiver. |
| Automation | Auto-book eligibility, queued jobs, release instants, priority, pause/resume, auto-upgrade, account and gym isolation, failures and notifications. Verify behavior when the gym is switched off or unlinked. |
| Credits and membership | Profile and credit display, membership/unmetered rules, eligibility, expiry, packages and checkout availability; do not execute payment or purchase. |
| Settings and data | Every gym's settings and visibility switch, linked versus disabled states, persistence, all-disabled state, favourites, spot preferences, account isolation and cache invalidation. Check that the switch's effects on background jobs and data retention are stated to users. |
| Calendar, history and notifications | Feed inclusion and refresh, cancellation reminders, booking-window alerts, history and Home statistics, per-gym preferences and account isolation when the gym is off or unlinked. |
| Operations and regression | Default-off activation gate, admin/catalogue presentation, logs and metrics without secrets, provider errors/backoff, mock/provider and cross-gym tests, full suite and client build. Clear browser caches and repeat desktop/mobile checks in real Chrome before and after the change. |

For each row record the tenant, exact configuration and capability under test, evidence source,
date, result and any unresolved limitation. Separate public-source facts from authenticated
captures and mock results; a mock never proves a live tenant's payment or mutation behavior.

## Homerun London and Barry's UK discovery — 2026-10-28

The user authorised public, read-only tenant, location, timetable and branding checks; login
and all writes were excluded. Homerun's [official site](https://homerun.london/) declares
the Mariana Tek tenant `homerun`. Its public classes response included Duke Street, London,
`Europe/London`, a published booking start and a pick-a-spot layout. Barry's
[official site](https://www.barrys.com/) declares tenant `barrysbootcamp`. Its public
locations response included UK locations, but its public class list also returned New York
classes: the tenant is global, so a UK-only integration must enforce tenant-configured
location scoping on every relevant read, including metadata and pagination. A timezone
default alone does not restrict the classes returned. A location-filtered public class
request for London Central (`9832`) returned GBP, `Europe/London`, pick-a-spot and a
published release. Public location IDs and names are provider data, not a permanent list:
the scoping design must account for locations being added or changed.

The real Chrome baseline on the local mock showed JAB and Psycle together on Home and a
JAB settings screen with connection and Auto-Upgrade controls, but no gym-wide switch.
The linked-gym list also feeds background polling and calendar generation, so hiding a
gym solely in the client would leave background activity running. No tenant login, booking,
payment or other write was performed. Neither tenant's authenticated capabilities or
booking policy have been accepted; public reads do not establish them.
The two initial public endpoint availability checks were made concurrently, contrary to
the live playbook's sequential-request rule; subsequent checks were made sequentially.
No throttling response was observed in these checks.

The draft registry entries are off by default in every environment. Set
`HOMERUN_ENABLED=true` and/or `BARRYS_UK_ENABLED=true` for an isolated mock trial;
production activation is a separate decision after the evidence and deployment gates.
The public embed configuration confirms the web OAuth client ID for both tenants.
Source assets: [Homerun wordmark](https://images.squarespace-cdn.com/content/v1/6a74902219941e665051561a/5473d500-e62e-4ca2-83e1-df954f9eea39/Homerun_Wordmark_Light.png)
and [Barry's wordmark](https://cdn.prod.website-files.com/6949433bade2d703c90660e8/69a01416ad65e37bff26565a_Logo_white.svg).
Compact marks come from each site's favicon: [Homerun](https://images.squarespace-cdn.com/content/v1/6a74902219941e665051561a/179f00fb-83f3-4a9e-a479-7bf687e80a45/favicon.ico)
and [Barry's](https://cdn.prod.website-files.com/6949433bade2d703c90660e8/69fb4324bc94ae6796923ff1_favicon.png).
These mock flags do not prove authenticated login, booking, waitlist, cancellation,
swap, purchase or the completeness of the UK region list. Review those before enabling
the tenants for real users. The marketing page reads the enabled gym catalogue and uses
the same presentation assets; its existing static logos are the fallback when unavailable.
Barry's reservation/history region fields, credits and account-wide entitlements have not
been captured: the region guard rejects rows whose region is missing instead of assuming
they are UK classes. The current UK region allowlist must be reviewed as locations change.

Local mock browser evidence: [settings before](../QA/browser-runs/2026-10-28-gym-discovery/settings-before.png),
[four-gym Home draft](../QA/browser-runs/2026-10-28-gym-discovery/home-draft.png),
[landing catalogue draft](../QA/browser-runs/2026-10-28-gym-discovery/landing-draft.png),
and [mobile dark Home draft](../QA/browser-runs/2026-10-28-gym-discovery/mobile-home-draft.png).
The mock shares a generic Mariana Tek fixture across tenants; its class names and locations
are not real Homerun or Barry's data. Chrome confirmed a disabled gym disappears from the
timetable, and that all gyms off shows a Settings action which can restore a gym.

### Implementation and acceptance checklist

- [ ] Define an account-specific enabled state, retaining linked credentials and settings;
  migrate existing databases with every existing link enabled by default.
- [ ] Pause queued automation and gym-specific reminders, remove disabled gyms from the
  calendar, and regenerate/rearm immediately on a state change. Protect dispatch against
  a switch made after a job was selected. Document the effect on already running work.
- [ ] Keep disabled gyms reachable in Settings for re-enabling, while excluding them from
  Home, timetable, filters, other merged surfaces and cached data; handle all gyms disabled.
- [ ] Configure each tenant, safe capabilities and source-backed brand assets. Restrict the
  global Barry's tenant to UK locations through tenant configuration and generic provider
  logic, including pagination and metadata; do not infer mutation behavior from public reads.
- [ ] Exercise migration, user isolation, switch persistence, background and calendar behavior,
  UK scoping and mock provider contracts; run the full suite and build.
- [ ] Repeat real-Chrome baseline and inspect Home, timetable, settings, marketing and
  branding in mobile/desktop and light/dark modes. Record remaining live-account gaps.

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
