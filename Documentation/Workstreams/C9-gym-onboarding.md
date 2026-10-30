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

### Review verification — 2026-10-29

Before changes, a local mock request deleted a retained queue entry for a disabled
gym; focused tests reproduced a booking after disabling during event lookup, omitted
a UK reservation on page two, and suppressed a release from before the disabled
interval. The causes are unguarded ID-based mutations, checks before asynchronous
preparation, first-page-only reservation reads, and the absence of an interval start.
Chrome showed the existing switch explanation in the local mock. No live writes ran.

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

Review follow-up: the per-account switch waits for an automatic booking or spot move already underway, including any required recovery after a cancellation. Provider writes check the switch at the actual outbound request boundary after internal read-only preparation; independent later actions cannot start while the switch is pending. A cancellation already issued may finish its rebooking and recovery before the switch responds. This coordination is process-local and assumes the supported single-server deployment. Older databases did not record when a gym was turned off; their existing queue cutoff is migrated conservatively so previously suppressed releases stay suppressed until reviewed.

The 2026-10-29 real Chrome mock check confirmed this wording in JAB settings ([screenshot](../QA/browser-runs/2026-10-29-review/gym-switch.png)). Targeted regressions cover provider-boundary races, recovery, disabled-gym ID routes and account isolation, pagination URL boundaries, repeated disabled intervals, and legacy database migration. Live authenticated booking and cancellation remain unverified and require separate acceptance authorization.

Follow-up verification: 100 server suites passed; 94 client test files and 728 tests passed; the production client build passed. Focused suites were rerun after the final provider and scheduler adjustments. The production build reported the existing large-chunk advisory.

Guest switch follow-up: deterministic scheduler regressions first reproduced a switch completing while a resumed guest write was in flight and an unissued guest being marked failed during switch-off. A guest mutation now holds the same lease even when the primary reservation already succeeded. If switching interrupts guest preparation or happens between guests, unattempted participants and the queue remain pending; already issued outcomes are preserved. The regression covers both cases and a provider write already in flight.

Guest follow-up verification: all 101 server suites passed. The preceding candidate's 94 client files and 728 client tests and production build passed; this follow-up changes no client files.

### Visual follow-up — 2026-10-30, verified before changes

Real Chrome against the isolated mock reproduced the credential overlay: the email field's center hit-tested to `.app-modal-overlay` on desktop. Computed styles showed an absolutely positioned overlay and a static modal card, allowing the overlay to paint above the form. An eight-location mobile tray displayed a flat grid, while a synthetic ten-location tray also remained flat (zero gym headings): the current location renderer always emits one grid. Barry's square mark is a small 32 px raster with a white background; the full and compact wordmarks share the same asset, and the timetable chip sets the configured width to 70 px. No actual credentials were read or submitted.

The shared modal card now creates its own stacking layer above its backdrop; real Chrome verified that the email field hit-tests, focuses and accepts mock input at desktop and mobile sizes in both themes, and the backdrop still dismisses the dialog. After clearing mock browser caches, a nine-location fixture stayed flat and a ten-location fixture showed two gym headings with selection retained ([light](../QA/browser-runs/2026-10-30-visual-fixes/filter-light.png), [dark](../QA/browser-runs/2026-10-30-visual-fixes/filter-dark.png)). Barry's square mark reuses the original wordmark's white vector paths on transparent background; the drawer's full wordmark is unchanged and its timetable width is configured separately. No actual gym credentials or live bookings were submitted.

Visual follow-up checks: 101 server suites, 95 client test files and 729 client tests passed; the client production build passed with the existing large-chunk advisory. The isolated mock browser tab and its storage were cleared afterward.

### Logo alignment follow-up — 2026-10-30, verified before changes

Real Chrome against the isolated mock measured Barry's square mark artwork center 0.3803 SVG units left of the center of its 16-unit square viewBox, with its vertical center correct. In both Your Gyms and the gym settings panes, 120 px plates contained Barry's 48 px and Aarmy's 40 px wordmarks: the banner inherited each gym's timetable-specific width. The original Your Gyms view is [captured here](../QA/browser-runs/2026-10-30-logo-alignment/before-your-gyms.png). No credentials or live gym writes were used.

After correction, real Chrome measured the square artwork center within 0.000001 SVG units horizontally and exactly centered vertically. The Your Gyms and gym-settings plates remained 120 px wide, while Barry's and Aarmy's wordmarks measured 80 px and 84 px respectively without clipping in desktop and mobile checks. Timetable widths remain 48 px and 40 px and the filter-drawer plates have no settings-only width ([Your Gyms after](../QA/browser-runs/2026-10-30-logo-alignment/after-your-gyms.png), [desktop settings](../QA/browser-runs/2026-10-30-logo-alignment/settings-desktop.png), [mobile dark settings](../QA/browser-runs/2026-10-30-logo-alignment/settings-mobile-dark.png)). A focused brand regression failed before the settings-only sizing seam and passed afterward.

Logo follow-up checks: all 101 server suites, 95 client test files and 730 client tests passed; the client production build passed with its existing large-chunk advisory. The isolated mock browser state was cleared afterward.

### Square logo and Home attendance follow-up — 2026-10-30, verified before changes

Real Chrome with the isolated all-gym mock reproduced the reported square-logo clipping: the shared inline SVG sprite showed only a sliver at the left edge while the exact same asset rendered correctly as an external image ([comparison](../QA/browser-runs/2026-10-30-logo-attendance/sprite-before.png)). The mark has a non-zero root viewBox, and the shared renderer puts that same viewBox on both an outer SVG and its nested symbol; the default `<use>` viewport applies an additional offset and clips the artwork. The earlier path-bounds check did not exercise this sprite rendering.

The same mock Home displayed “Some gym attendance data could not be loaded.” Barry's and Homerun deliberately declare `attendanceTotals: false`; Home skips their attendance endpoint but then treats that unsupported capability as a failed request. Booking-history totals are not a reliable substitute for attended classes, and no Barry's authenticated history request is needed to reproduce this particular warning. The user separately authorised read-only authenticated Barry's history diagnostics, excluding all writes, but none were made for this diagnosis.

After normalizing the Barry's mark to a zero-origin square with an equivalent path transform, real Chrome rendered the inline sprite and external image identically: both had 3,739 light pixels and horizontal artwork bounds 64–135 inside their 200 px comparison plates; before the change the sprite had 1,337 light pixels at 40–66 ([before](../QA/browser-runs/2026-10-30-logo-attendance/sprite-before.png), [after](../QA/browser-runs/2026-10-30-logo-attendance/sprite-after.png)). Shared square marks at 24, 40 and 56 px were visibly centered ([comparison](../QA/browser-runs/2026-10-30-logo-attendance/square-sizes.png)), and the actual header, Home and settings rail displayed the corrected mark in desktop/mobile and light/dark checks.

Home now reports that some gyms do not yet provide attendance totals when a linked gym's capability is disabled. Actual request failures still show the loading-failure warning, unavailable gyms still suppress the combined total, and no booking counts are represented as attendance. Real Chrome showed the accurate unavailable message with no failure warning in the all-gym mock ([Home](../QA/browser-runs/2026-10-30-logo-attendance/home-light.png)). Focused sprite and Home regressions failed before the change and passed afterward.

The changed mark URL is versioned as `barrys-mark.svg?v=2`: the service worker checks all caches before its asynchronous old-cache purge finishes, so a distinct URL prevents the old clipped asset from being reused during activation. Chrome confirmed the versioned symbol and its centered appearance in the actual [mobile Your Gyms thumbnail](../QA/browser-runs/2026-10-30-logo-attendance/versioned-mobile.png), as well as [light](../QA/browser-runs/2026-10-30-logo-attendance/your-gyms-light.png) and [dark](../QA/browser-runs/2026-10-30-logo-attendance/your-gyms-dark.png) settings views.

Square-logo and attendance follow-up checks: 101 server suites, 96 client test files and 732 client tests passed; the client production build passed with its existing large-chunk advisory. The versioned gym configuration and focused sprite/Home tests were rerun after the final asset URL change. Mock browser state was cleared, and no live authenticated history request or live gym write was made.

#### Barry's official attendance totals — 2026-10-30

The disabled-capability behavior above was the baseline: `barrys-uk` declared `attendanceTotals: false`, so Home skipped the supported `/api/attendance-totals` request. The MarianaTek adapter already maps `/me/achievements.classes_completed` through the shared `attendedTotal` contract. The user supplied a sanitized Barry's achievements response with `classes_completed: 612`; this is account-wide across the tenant and must not be described as a UK-only total. Enabled the capability only for Barry's UK and made the dev mock return that fixture for this gym. Focused test: `node server/test-mariana-attendance.js` (5/5 passed); JAB and Aarmy capability behavior remains covered unchanged. Real Chrome baseline opened sweat-dev to the logged-out landing page, so the Home baseline was not independently visible in that session. Post-change authenticated browser evidence is pending the integration deploy.
