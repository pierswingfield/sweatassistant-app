# Issues Log — 2026-09-23-lane-live

Pre-existing issues QA-01 through QA-15 documented in [2026-09-15-local-mock ISSUES.md](../2026-09-15-local-mock/ISSUES.md).

## QA-16 — Unmetered gyms (e.g. JAB Boxing Club) without active membership render "Buy Credits" button on open classes

- Severity: P1
- Flow: WIN-04 step 3
- Environment/build: `http://localhost:5173` (Vite dev client) / `http://localhost:3000` (Server), commit `8387d53dd21b1107c3a3cbba2238b399ba39b76c`
- Browser/device: agent-browser (Chromium), macOS, 1280x720, dark theme
- Persona/gym: Multi-gym (`test@piersj.com` linked to live JAB Boxing Club and Psycle London accounts)
- Frequency: 100% reproducible on unmetered gym when account lacks active membership
- Confidence: Confirmed
- Cleanup impact: None

### Preconditions
Sweat Assistant account linked to an unmetered gym (JAB Boxing Club) where user holds no active membership and no credits (`/api/eligibility` returns `{ canBook: false, reason: "No active membership or credits" }`).

### Steps to reproduce
1. Navigate to Timetable tab (`#class-timetable`).
2. Select a date within the booking window (e.g. `THU 24 SEPT`).
3. Locate an open JAB class (e.g. `06:30 JAB TRAIN`).
4. Inspect primary action button and status column tooltip.

### Expected
For an unmetered platform (`capabilities.metered: false`, `capabilities.creditPurchase: false`), when an account is ineligible to book due to lack of membership, the primary action button should indicate membership requirement (e.g. "No Membership", "Manage at gym", or disabled state) reflecting the unmetered membership model, rather than advertising credit purchase.

### Actual
The primary action button displays `Buy Credits` (`psycle-tt-seg primary variant-danger`). Clicking it switches to the `Credits & Membership` tab where JAB shows `Membership — No membership found` and has no credits or purchase flow available.

### Evidence
- Screenshot: `screenshots/win-04-entitlement-jab.png` (top panel shows `06:30 JAB TRAIN 19 / 40 Buy Credits` and `06:30 JAB RECOVERY 4 / 5 Buy Credits`)
- Status pill hover tooltip: `title="No active membership or credits"`
- API: `GET /api/eligibility` (header `x-gym-id: jab-boxing`) returns `{ canBook: false, reason: "No active membership or credits" }`

### Notes
In `client/src/ui/timetable.js:1463`, `buildActionModel()` checks `if (!hasCredit)` and hardcodes `{ primary: { label: 'Buy Credits', variant: 'danger', run: () => window.switchTab('buy-credits') } }`. In `credit-allowance.js:91`, `hasUsableCredit()` requires `canBookAtAll(gymId)`, which returns false when eligibility fails. When `!isMetered(gymId)` or `!canForGym('creditPurchase', gymId)`, the action should reflect membership status rather than "Buy Credits".

## QA-17 — Header gym badge unconditionally renders "Member" for unmetered gyms without checking active membership

- Severity: P2
- Flow: WIN-04 step 2 & step 3
- Environment/build: `http://localhost:5173` (Vite dev client) / `http://localhost:3000` (Server), commit `8387d53dd21b1107c3a3cbba2238b399ba39b76c`
- Browser/device: agent-browser (Chromium), macOS, 1280x720, dark theme
- Persona/gym: Multi-gym (`test@piersj.com` linked to live JAB Boxing Club)
- Frequency: 100% reproducible for unmetered gyms
- Confidence: Confirmed
- Cleanup impact: None

### Preconditions
Sweat Assistant account linked to JAB Boxing Club where user holds no active membership (`GET /api/membership` returns `{ membership: null }`).

### Steps to reproduce
1. Log in as `test@piersj.com` in a session linked to JAB.
2. Inspect the gym status badges in the top right header (`#psycle-header-credits`).

### Expected
If the account lacks an active membership on an unmetered gym, the badge should reflect actual status (e.g. "Inactive", "No Membership", or omitted pill), aligning with `Credits & Membership` ("No membership found") and `/api/eligibility` (`canBook: false`).

### Actual
Header badge unconditionally renders `<span class="psycle-hgb-name">JAB</span><span class="psycle-hgb-pill member">Member</span>` with `title="JAB: Membership active"`, falsely displaying active membership.

### Evidence
- DOM: `<button type="button" class="psycle-header-gym-badge psycle-header-gym-jab-boxing" title="JAB: Membership active"><span class="psycle-hgb-name">JAB</span><span class="psycle-hgb-pill member">Member</span></button>`
- Contradiction: Credits tab displays `Membership — No membership found. Bookings will be refused until this gym has an active membership.`
- Screenshot: visible in header of `screenshots/win-04-entitlement-psycle.png` and `screenshots/win-04-entitlement-jab.png`

### Notes
In `client/src/main.js:555-573`, `renderGymBadge()` checks `if (isMetered)` ... `else { badge.innerHTML = ... "Member"; badge.title = "... Membership active"; }`. It assumes that any unmetered gym implies active membership, without verifying `cache.eligibilityByGym[gymId]` or `cache.membership`.

## QA-18 — Settings Spot Maps modal renders "Unknown Location" for secondary gym and fails to pass gymId to studio floor plan editor

- Severity: P1
- Flow: MAP-01
- Environment/build: `http://localhost:5173` (Vite dev client) / `http://localhost:3000` (Server), commit `8387d53dd21b1107c3a3cbba2238b399ba39b76c`
- Browser/device: agent-browser (Chromium), macOS, 1280x720, dark theme
- Persona/gym: Multi-gym (`test@piersj.com` linked to live JAB Boxing Club and Psycle London)
- Frequency: 100% reproducible when opening Manage Spot Maps for a non-default linked gym
- Confidence: Confirmed
- Cleanup impact: None

### Preconditions
Sweat Assistant account linked to multiple gyms (e.g. Psycle London as active/default gym, JAB Boxing Club as secondary gym).

### Steps to reproduce
1. Navigate to Settings > JAB Boxing Club.
2. Click "Manage maps" under Preferred Spot Maps.
3. Observe the studio location header.
4. Click "Choose Spots" on BOXING or TRAIN.

### Expected
1. Studios should be grouped under their actual location name ("SW1").
2. Clicking "Choose Spots" should open the floor plan editor for that gym's studio with its layout rendered.

### Actual
1. Studios are grouped under "Unknown Location" accordion.
2. In `client/src/ui/settings.js:858`, `editBtn.addEventListener('click', () => openStudioFloorPlanEditor(studio.id, studio.name, () => openManageSpotMapsModal(options), { ...options, gymId: studio.gymId }))` passes `gymId: studio.gymId`. Because `studio` returned by `api.getMetadata` lacks an explicit `studio.gymId` property, `studio.gymId` is `undefined`, clobbering `options.gymId: 'jab-boxing'`. `openStudioFloorPlanEditor` then calls `api.getStudioLayout(studioId, undefined)`, hitting `/api/studios/:id/layout` without `x-gym-id`, querying Psycle London instead of JAB. The layout query returns `{ slots: [] }` and falls back to "No floor map available".

### Root Cause
1. In `client/src/ui/settings.js:711`:
   `let locations = cachedMeta?.locations || cache.locations || [];`
   When `options.gymId` is supplied, `cachedMeta` is deliberately null, but `cache.locations` holds the previous gym's (Psycle) locations in memory. `locations.length` is truthy, so the branch fetching JAB's locations from `api.getMetadata` is skipped. When filtering by `gymId`, JAB locations are missing, so `locMap[locationId]` is undefined, falling back to `'Unknown Location'`.
2. In `client/src/ui/settings.js:858`:
   `{ ...options, gymId: studio.gymId }` overwrites `options.gymId` with `undefined`. It must use `studio.gymId || options.gymId`.

### Evidence
- Screenshots: `screenshots/map-01-jab-boxing-map.png`, `screenshots/map-01-jab-train-map.png`
- DOM inspection: modal header shows `UNKNOWN LOCATION` with accordion containing `BOXING` and `TRAIN`
- API validation: `/api/studios/6286/layout` with `x-gym-id: jab-boxing` returns HTTP 200 with 40 spots (`Bag` and `Ground`), whereas without `x-gym-id` it queries CodexFit and returns `{ slots: [], objects: [] }`
## QA-19 — My Bookings renders "Spot ?" for classes with first-come-first-serve / no-layout format

- Severity: P2
- Flow: MAP-04 step 3
- Environment/build: `http://localhost:5173` (Vite dev client) / `http://localhost:3000` (Server), commit `8387d53dd21b1107c3a3cbba2238b399ba39b76c`
- Browser/device: agent-browser (Chromium), macOS, 1280x720, dark theme
- Persona/gym: Multi-gym (`test@piersj.com` linked to live JAB Boxing Club)
- Frequency: 100% reproducible for any booking in an unmapped/FCFS studio
- Confidence: Confirmed
- Cleanup impact: None

### Preconditions
A booking exists in a studio that operates on a first-come-first-serve (FCFS) basis without individual assigned spots (e.g. JAB RECOVERY, `layoutFormat: 'first-come-first-serve'`).

### Expected
My Bookings should recognize that the class has no individual assigned spots and present a clean label such as "No assigned spot", "Free seating", or omit the spot chip entirely, treating unmapped seating as a first-class supported model.

### Actual
In `client/src/ui/bookings.js:203`:
```javascript
const slotLabel = b.raw?.spot?.name ?? b.studio_slot?.label ?? b.slot ?? b.studio_slot_id ?? b.slot_id ?? slotId ?? '?';
```
Because FCFS classes have no spot record, all spot accessors evaluate to null/undefined, and `slotLabel` defaults to `'?'`. In line 233, this renders as:
`<button class="ab-spot-upgrade-chip ...">${nounCap} ${slotLabel}</button>` -> `Spot ?` (or `Mat ?`), creating false impression of missing or corrupt data.

### Root Cause
`bookings.js` lacks an explicit check for `!hasMap` or `event.layoutFormat === 'first-come-first-serve'` when rendering spot chips. While it correctly suppresses the `Edit` button on line 240 (`(within12h || !hasMap) ? '' : ...`), it unconditionally renders the spot chip with fallback `'?'`.

### Evidence
- Code inspection: `client/src/ui/bookings.js:203` and `client/src/ui/bookings.js:233-241`
- Screenshots: `screenshots/map-04-fcfs-no-map-fallback.png`

## QA-20 — Server push notification titles and templates hardcode "Psycle:" and "Psycle" regardless of originating gym

- Severity: P2
- Flow: NOTIF-01 step 5
- Environment/build: `http://localhost:5173` (Vite dev client) / `http://localhost:3000` (Server), commit `8387d53dd21b1107c3a3cbba2238b399ba39b76c`
- Browser/device: agent-browser (Chromium), macOS, 1280x720, dark theme
- Persona/gym: Multi-gym (`test@piersj.com` linked to live JAB Boxing Club and Psycle London accounts)
- Frequency: 100% reproducible on all push notification dispatches and debug test samples
- Confidence: Confirmed
- Cleanup impact: None

### Preconditions
User is linked to multiple gyms (e.g. Psycle London and JAB Boxing Club) or a non-Psycle gym.

### Steps to reproduce
1. Enable debug mode in Settings > General.
2. In Settings > Notifications, under "🔔 Test Notifications", trigger any test notification (e.g. "Spot Booked", "Spot Upgraded", "Cancellation Reminder", "Booking Window").
3. Inspect notification payloads produced by `server/notifications.js:buildSample()` and live dispatch `notify()`.

### Expected
Notification titles and copy should dynamically incorporate the originating gym's brand/name (e.g. `JAB: Spot Booked`, `Reminder: JAB Class`, `JAB booking opens in 1 hour`) or use gym-neutral copy based on `ctx.gymId`, adhering to WP-D7 ("No gym is privileged above the adapter layer").

### Actual
In `server/notifications.js`:
- Line 101: `title: 'Psycle: Spot Booked'` (unconditionally hardcoded)
- Line 111: `title: 'Psycle: Spot Upgraded'`
- Line 109: `body += ' Your previous spot was not cancelled, speak to Psycle to cancel without penalty.'`
- Line 127: `title: 'Psycle: Credit Warning'`
- Line 136: `title: 'Reminder: Psycle Class'`
- Line 143: `title: 'Psycle: Booking Window'`
- Line 144: `body: 'Psycle booking opens in 1 hour.\n...'`

When auto-booking or upgrade succeeds for a JAB Boxing class, or when a JAB class cancellation reminder fires, the notification sent to the member will erroneously claim to be from "Psycle".

### Root Cause
`server/notifications.js` has not yet been updated for the modular multi-gym architecture. Its body builders (`buildBooking`, `buildUpgrade`, `buildCreditWarning`, `buildCancellationReminder`, `buildBookingWindow`) do not accept or read `ctx.gymId`, nor do they query `gyms.config.js` for `gym.shortName` / `gym.name`.

## QA-21 — Settings > About pane interpolates only one gym name for multi-gym accounts

- Severity: P3
- Flow: SET-01 step 1
- Environment/build: `http://localhost:5173` (Vite dev client) / `http://localhost:3000` (Server), commit `8387d53dd21b1107c3a3cbba2238b399ba39b76c`
- Browser/device: agent-browser (Chromium), macOS, 1280x720, dark theme
- Persona/gym: Multi-gym (`test@piersj.com` linked to live JAB Boxing Club and Psycle London accounts)
- Frequency: 100% reproducible for multi-gym accounts
- Confidence: Confirmed
- Cleanup impact: None

### Preconditions
Sweat Assistant account linked to more than one gym (e.g. Psycle London and JAB Boxing Club).

### Steps to reproduce
1. Navigate to Settings > About (`#psycle-settings-pane-about`).
2. Read the header and introductory copy.

### Expected
The About section should recognize that the user has multiple gyms connected, referencing "your gyms" or listing both gyms (e.g. "an unofficial companion for JAB Boxing Club and Psycle London"), avoiding singular attribution to just one gym.

### Actual
The text reads:
`Sweat Assistant — an unofficial companion for JAB Boxing Club, built for personal use.`
`Sweat Assistant is an unofficial personal tool — not affiliated with or endorsed by JAB Boxing Club.`
Psycle London is completely omitted from the disclaimer and overview despite being linked and active.

### Root Cause
In `client/src/gym-context.js:71-77`:
```javascript
export function applyGymName(ctx = state) {
  const name = ctx.name;
  if (!name) return;
  document.querySelectorAll('[data-gym-name]').forEach((el) => {
    el.textContent = name;
  });
}
```
`applyGymName()` reads `state.name` (a single active gym name) rather than querying `getLinkedGyms()`. If multiple gyms are linked, it should render "your gyms" or join the linked gym names.

## QA-22 — Timetable row Debug modal renders unredacted raw event JSON exposing provider credentials (shopify_api_password)

- Severity: P0
- Flow: SET-05 step 3
- Environment/build: `http://localhost:5173` (Vite dev client) / `http://localhost:3000` (Server), commit `8387d53dd21b1107c3a3cbba2238b399ba39b76c`
- Browser/device: agent-browser (Chromium), macOS, 1280x720, dark theme
- Persona/gym: Multi-gym (`test@piersj.com` linked to live Psycle London account)
- Frequency: 100% reproducible when opening Debug modal on Psycle classes
- Confidence: Confirmed
- Cleanup impact: None

### Preconditions
Debug Mode is enabled in Settings > General.

### Steps to reproduce
1. Enable Debug Mode in Settings > General.
2. Navigate to Timetable tab (`#class-timetable`).
3. Click the more actions menu (`⋯`) on any Psycle London class row (e.g. `06:20 REFORMER Signature 50`, event ID 215948).
4. Click "Debug".
5. Inspect the "Event Data" raw JSON section rendered in `#psycle-debug-modal-body`.

### Expected
The client debug modal must strictly sanitize all raw provider payloads before rendering them to the DOM, stripping or redacting any sensitive keys matching patterns like `*password*`, `*secret*`, `*key*`, `*token*`, or payment/API credentials.

### Actual
In `client/src/ui/timetable.js:3451-3453`, `openDebugModal()` fetches raw event details via `api.getEventDetails()` and dumps the unredacted event JSON directly into the DOM inside `<pre class="psycle-code-block">`.
For Psycle classes, CodexFit's raw organisation relations payload contains:
`"shopify_api_password": "[REDACTED]"`
exposing live third-party API credentials in plaintext inside the browser client DOM.

### Root Cause
Neither the server adapter (`providers/codexfit.js`) nor the client debug viewer (`timetable.js:openDebugModal()`) sanitize sensitive key-value pairs before serialization and DOM injection.




