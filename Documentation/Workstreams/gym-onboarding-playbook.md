# Gym onboarding playbook and Aarmy trial

**Status: Aarmy is wired for local development and remains disabled in production.** This
is the repeatable path for adding a gym whose platform is already supported. It is an
onboarding and acceptance record, not an instruction to deploy or expose the gym.

## What exists already

| Resource | Use it for |
|---|---|
| `server/gyms.config.js` | The tenant registry: provider, endpoints, headers, policy, capabilities and all presentation data. |
| `server/providers/base.js` and `normalize.js` | The normalized provider contract that the routes, scheduler and client consume. |
| `server/providers/codexfit.js` / `marianatek.js` | Platform protocol only: authentication, API requests and conversion to normalized shapes. |
| `server/providers/index.js` | Resolving a provider instance from the configured gym ID. |
| `server/mock*.js`, `test-*-mock.js` | Exercising provider flows with no real account or balance. |
| `Documentation/Services/*.md` | Captured platform facts and unknowns. Update with sanitised evidence from a new tenant. |
| `LIVE_VERIFICATION_PLAYBOOK.md` | Read-only and write-path limits for a real account. |
| `TESTING.md`, `test-gym-isolation.js`, `test-no-gym-privilege.js` | Regression, isolation and no-hardcoding gates. |

## Repeatable onboarding sequence

### 1. Scope and identify the platform

1. Record the public gym URL, booking subdomain, primary timezone, locations, brand assets,
   intended launch state and a test account with no paid action authorised.
2. Identify the API platform from browser traffic and page assets. Match it to an existing
   adapter only when the authentication flow and read endpoints are materially compatible.
3. Capture only the minimum sanitised read responses needed to establish: login/session
   renewal, profile, timetable, event detail/layout, booking availability, bookings,
   waitlists, credits or membership, and per-class booking release. Store captures under the
   platform fixture/documentation convention; never store account credentials or tokens.
4. If the protocol does not fit an adapter, create a platform adapter that implements the
   `GymProvider` contract. Do not introduce branches on a gym ID above `providers/`.

### 2. Add the tenant configuration

Add one entry to `GYMS` in `server/gyms.config.js`. It owns:

- Stable `id`, name, website, provider, timezone, tenant/API/OAuth/login URLs and browser-
  fidelity headers.
- A development-only mock identity and an explicit production enable flag that defaults off.
- `theme`, `presentation` (wordmark, mark, plates, light/dark colours and display aliases),
  labels and location aliases. Add the referenced images under `client/public/gyms/`.
- Capability flags. Set these from observed platform behaviour, including swap, native
  waitlist, metering, credit purchase, bookmarks, booking window and maximum spots.
- Booking policy. A MarianaTek tenant normally uses `per-class`: preserve the API's
  `booking_start_datetime`; a continuous fallback is only a documented fallback for missing
  values and must be confirmed for that tenant.

The client receives the presentation/capability configuration through the normal gym context;
no component should require a new gym-name conditional.

### 3. Wire and prove normalized behaviour

1. Confirm `getProvider(gymId)` returns the configured platform adapter and all timetable
   events have the new `gymId`.
2. Check normalized fields rather than raw platform fields: `startAt`, `endAt`, location and
   studio identifiers/names, instructor objects, availability, slots and `releaseAt`.
3. For MarianaTek, prove pick-a-spot and first-come-first-served details separately; FCFS has
   no layout and must return an empty slot list. Payment options must be resolved before a
   booking or waitlist mutation.
4. Exercise mock login, timetable, event detail, booking, cancellation, waitlist and swap.
   A real account with no credit can only prove the read/authentication paths unless a
   separate explicitly authorised safe write test is arranged.
5. Run the targeted mock suite, provider/isolation suites and the relevant client build/tests
   using the project Node 20 runtime. Run tests serially where the shared booking mock is
   mutable.

### 4. Live-account acceptance and activation

Follow `LIVE_VERIFICATION_PLAYBOOK.md` and the browser rules in `AGENT_PROTOCOL.md`.
Before each live session, inventory bookings, waitlists and credits. Keep within the request
budget and test read routes first. Do not book, pay, cancel existing bookings or test
penalty-window cancellation without the required specific authorisation.

Activation requires all of the following:

- Successful real login and session refresh/re-login with the tenant configuration.
- Profile, timetable, class detail/layout, bookings/waitlists and membership/credit reads
  validated in the live API and real Chrome UI.
- `releaseAt` observed on the tenant's classes; its fallback rule corroborated or removed.
- No provider or client code path uses the gym ID, hostname or presentation name as a special
  case; isolation and no-gym-privilege tests pass.
- A production enable decision, deployment plan and post-deploy browser acceptance. Enabling
  an environment variable alone is not an acceptance result.

## Aarmy trial (2026-09-30)

Aarmy was identified as a MarianaTek tenant at `mt.aarmy.com`. The configuration uses the
`aarmy` tenant/API/OAuth routes, `America/New_York`, per-class release times with a provisional
14-day continuous fallback, Aarmy presentation assets, and a production-off `AARMY_ENABLED`
gate. The shared MarianaTek adapter was changed once to remove its JAB-only mock-email
assumption; it now reads `gym.mockEmail`.

The local Aarmy mock test proves adapter resolution, mock login, gym-qualified timetable events
and preserved release times. It does **not** prove that Aarmy's live OAuth flow, account data,
release fallback, floor plan, or payment-option shape matches JAB's captures.

No Aarmy booking, waitlist, cancellation, swap or payment action has been tested with the real
account. Aarmy has not been enabled in production, deployed, or presented as launch-ready.

## Findings and recommendations

### Architecture assessment

CodexFit and MarianaTek have the same modular boundary: a registry entry selects a platform
adapter, and everything above it consumes normalized values and capability flags. MarianaTek is
slightly more tenant-ready for a third gym because its provider was already built around
`this.gym` URLs and headers. Their protocol surfaces are intentionally not structurally
identical: CodexFit uses its own profile/cart/window semantics; MarianaTek uses OAuth/PKCE,
published per-class release instants and payment-option resolution. Do not force them into a
shared raw API abstraction.

| Priority | Gap found | Recommendation | Acceptance evidence |
|---|---|---|---|
| P0 | The mock login was hardcoded to JAB's development address, so a second MarianaTek tenant could not use the shared mock path. | Keep the `gym.mockEmail` configuration seam and add a registry-level contract test for every enabled development gym. | Aarmy and JAB mock login tests pass without provider edits. |
| P0 | Aarmy is configured from a subdomain and known platform pattern, but live protocol compatibility is unproven. | Complete a paced, read-only capture against the supplied test account; compare the sanitised shapes with the MarianaTek adapter fixtures before enabling it anywhere. | Auth, profile, timetable, details, bookings, waitlists and membership/credits read in live API and Chrome. |
| P1 | The 14-day fallback is a policy assumption. It could release an event incorrectly when Aarmy omits `booking_start_datetime`. | Observe classes with and without the published field. Retain the fallback only if evidence confirms it; otherwise configure the correct tenant policy or make missing release unavailable to auto-book. | Documented capture and a policy regression test. |
| P1 | A new tenant still needs manual config and asset work. This is configuration-driven but is not yet UI-onboardable. | Define a validated gym-config schema and admin draft/preview flow for registry fields, assets, capability declarations and explicit activation. Keep secrets outside the schema. | Invalid draft rejected; preview uses its own branding; activation needs recorded live acceptance. |
| P1 | MarianaTek metadata is inferred from active timetable data, so quiet studios/instructors are absent. | Present it as a current schedule catalogue and add a provider metadata endpoint only if the platform exposes a stable authoritative source. | Empty/quiet timetable behaviour is specified and tested. |
| P2 | Live write paths remain platform and tenant dependent, especially credits, penalties and waitlist promotion. | Maintain a per-tenant capability/evidence matrix; gate UI actions on proven capability plus explicit live acceptance, with mock flows covering state transitions. | Each live mutation has a sanitised capture and authorised safe test. |

## Completion checklist for the next gym

- [ ] Platform and tenant identity evidenced from live read traffic.
- [ ] One config entry, assets and a production-off activation gate added.
- [ ] Existing adapter selected or new adapter implements the normalized contract.
- [ ] Mock and focused isolation/no-privilege tests pass under Node 20.
- [ ] Live read-only acceptance recorded, including session renewal and booking-release data.
- [ ] Live mutation coverage explicitly recorded as passed, deferred or unauthorised.
- [ ] Real-Chrome UI acceptance passes after cache clearing.
- [ ] Production activation separately approved, deployed and rechecked.
