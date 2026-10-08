# Offline PWA baseline audit — 2026-10-02

> **Closed and archived 2026-10-08 by user confirmation:** the PWA follow-up checks in this audit are considered complete. The audit below is historical evidence from 2026-10-02 and does not represent current open work. This closure is user-confirmed, not a new device verification.

**Scope at audit time:** baseline plus the 2026-10-02 shared-foundation implementation for the
installed iOS PWA report: offline launch, cached reads, assets, visual state and write safety
across Psycle, JAB Boxing and Aarmy (then disabled). At the time, this was not a completed
acceptance item. The 2026-10-08 user-confirmed closure above supersedes the follow-up list below.

## Evidence and boundary

- Source was inspected on the current dirty worktree without modifying existing files.
- Real Chrome 154 on 2026-10-02 had a `sweat-dev.wingfield.tech` timetable tab with a visible
  offline banner while `navigator.onLine` was true. It had CacheStorage generations, eight
  cached instructor photos and the IndexedDB `api-responses`/`cache` stores, but it was not
  service-worker controlled.
- One disposable Chrome tab loaded the dev twin, became service-worker controlled, was put
  offline and reloaded. The cached shell and offline banner rendered. It was unauthenticated, so
  it is **not** evidence for cached personal data, installed iOS behaviour, or a cold launch.
- `npm run test:client` is still required after any implementation. It is not evidence of DOM,
  service-worker or iOS behaviour; this audit adds no test or production change.

## Foundation implementation — 2026-10-02

- **Built shell and brand assets:** `client/vite.config.js` now enumerates the production
  `dist/assets/` and `dist/gyms/` files and stamps that URL list into `dist/sw.js`. The service
  worker adds it to the shell's atomic `cache.addAll()` install. This covers the Vite entry JS/CSS
  and the Psycle, JAB and Aarmy wordmarks/marks; it does **not** cache any authenticated API.
- **Offline state:** the persistent banner is now an accessible status message with a Retry
  control. It remains visible until the authenticated connection probe succeeds.
- **Writes:** every `apiFetch()` POST, PUT, PATCH or DELETE now passes a shared guard. When the
  app has confirmed offline state (or the browser reports offline), it rejects before fetch with
  `OFFLINE_MUTATION_BLOCKED`. GET reads remain available. No write queue was added.
- **Account-scoped snapshots (2026-10-02 follow-up):** IndexedDB schema v3 adds
  `offline-snapshots`, keyed by the authenticated account plus a resource and, where relevant,
  `gymId`. It stores normalized read responses for linked/public gyms, bookings, waitlists,
  calendar status, settings, studio preferences, profiles and eligibility. Recursive sanitising
  removes credential/token/session/secret keys and calendar link fields before every write.
  Logout's existing `clearApiCache()` now clears this store too; another account cannot address
  the prior account's keys.
- **Checks:** client Vitest: 28 files / 204 tests passed. Production client build passed and
  `node --check client/dist/sw.js` passed. In one disposable real Chrome tab against the built
  preview, the service worker controlled the page, its caches contained the Vite entry and JAB /
  Aarmy logo assets, and an offline reload rendered the shell, persistent banner and Retry button.
  Local `npm run dev` did not start its server because `ENCRYPTION_KEY` was absent; this did not
  affect the built-preview service-worker check.
- **Follow-up checks:** client Vitest: 28 files / 205 tests passed; production build and worker
  syntax check passed. In a disposable real-Chrome local mock profile (Psycle + JAB), online
  loading created 16 account-scoped snapshots, including both gyms' profile/settings/preferences.
  After network emulation and reload, the app showed a saved-data timestamp, did not show a
  generic booking error, and action buttons were disabled. A recursive key audit found no
  password, token, credential, session or calendar-link fields in those records.

## Matrix

| Resource / view | Current cache or fallback | Observed failure / gap | Proposed fallback | Staleness, security and PII | UI action policy | Verification evidence and unknowns |
|---|---|---|---|---|---|---|
| App shell, manifest and icons | `sw.js` precaches shell/icon entries plus a Vite-stamped list of every built `/assets/` and `/gyms/` file. Navigation falls back to cached `index.html`. | **Implemented:** the hashed JS/CSS cold-launch gap is closed for a successfully installed worker. A first ever offline visit and storage eviction still have no app to load. | Retain a minimal static offline screen if atomic install fails. | Public assets only; version cache with the existing build stamp. Keep the last known good generation until the new one is complete. | Reads only; offline shell must never imply data is current. | Disposable Chrome built-preview offline reload passed; cache contained entry JS and JAB/Aarmy assets. Cold iOS install and eviction remain untested. |
| Bootstrap configuration and auth restoration | `initConfig()` falls back to build-time `app.config.json` values if `/api/config` fails. A locally stored SA token and user ID are retained. | `/api/auth/status` is network-only. Offline launch uses `initApp()` only after a fetch failure sets offline state; a non-network status failure can route to login. | Store a minimal authenticated bootstrap record, signed only by the server token lifecycle; differentiate unreachable from invalid token. | Do not persist password or gym credentials. Stored identity must be account-scoped and cleared on logout. | Login, signup and recovery remain online-only. | Source verified in `config.js` and `main.js`; expired-token/offline transition not browser-tested. |
| Connectivity banner and recovery | `main.js` creates a persistent, polite offline status with Retry; fetch errors dispatch `psycle-network-fail`; reconnect probes authenticated `/api/auth/status`. CSS globally disables most action controls. | **Implemented:** Retry and accessible persistent state. It still has no cached-at time and does not distinguish no network, server outage, auth expiry or stale data. | Add per-panel cached-at labels; revalidate only after a successful authenticated probe. | Connection state contains no PII. Never treat `navigator.onLine` as proof of server reachability. | Navigation and cached reads remain enabled; API-layer mutation guard now backs up CSS. | Built-preview Chrome offline reload showed banner and Retry. iOS standalone reconnection remains unknown. |
| Timetable and filter metadata | `timetable.js` stores account-scoped merged events and metadata in IndexedDB `cache`, with localStorage fallback. Warm cache paints before network. | This is the only substantial persistent offline data path. Cache writes only when fresh events are non-empty; no explicit cached-at marker is rendered and booking overlays still require separate data. | Retain the current cache, add row/panel stale disclosure, cache version/schema and bounded retention; continue gym-qualified event data. | Timetable reveals gym attendance preferences. Scope by account and clear on logout; preserve gym IDs to avoid cross-tenant leakage. | Timetable browsing, filters and detail display allowed offline. Booking affordances must be disabled/labelled offline. | Source verified; authenticated offline timetable display was not exercised. |
| Bookings and waitlists | **Implemented:** normalized responses persist in account-scoped `offline-snapshots`; multi-gym rows retain `gymId`/`gymName`. | Cold snapshot now produces explicit saved-data absence text instead of a generic load error. There is no encrypted-at-rest guarantee beyond the device/browser profile. | Add a retention/expiry decision and an optional device-lock threat model before broader rollout. | High-sensitivity personal schedule and location data. Account scope and logout clear are implemented; do not cache old accounts. | Read-only cards may be shown stale. Cancel, leave, swap and booking writes remain disabled. | Mock Chrome seeded bookings/waitlists and reloaded offline without a generic booking error; real account/iOS check remains required. |
| Linked gyms and gym context | **Implemented:** `getMyGyms()` and public `getGyms()` persist snapshots; `loadGymContext()` consumes them and restores capabilities/presentation on a warm offline launch. | No snapshot now has explicit "no saved gym connections" copy. Public catalogue is still stored only after an authenticated app read, not used to infer links. | Add snapshot retention telemetry. | Linked membership is PII. Never use a public catalogue to infer a user's links; account scope and logout clear apply. | Gym list browsable stale; link, relink, unlink and active-gym changes online-only. | Mock Chrome created the scoped catalogue/link snapshots; real iOS/Aarmy activation remains untested. |
| Profiles, credits, membership and eligibility | Credits and membership use `getCachedSWR`; settings without a gym and single-gym studio preferences do too. Profiles, eligibility and per-gym settings/preference fan-outs are network-only. | Cache coverage is uneven. Missing per-gym profile/eligibility can make an offline timetable show a stale card but omit bookmark, booking-window and ability explanations. | Snapshot each normalized per-gym read together with its gym ID, freshness and capability version; tolerate unknown eligibility rather than reporting zero credits. | Credit/membership and profile information are PII. Keep account/gym scope and explicit invalidation after a mutation. | Show stale balances and membership only when marked. Bookmark, profile and settings saves remain online-only. | Source verified. Existing cache store presence observed, record contents not inspected. |
| Auto-Book and Auto-Upgrade | Queue/monitor GETs use 30-second `getCachedSWR` plus memory caches; SSE has reconnect handling. | These records can survive offline only if previously read and the API cache is intact. Status freshness is not visible and the stream cannot update offline. | Keep persistent snapshots with cached-at and clear “server continues running” copy; revalidate on reconnect. | Queue entries reveal classes and preferred spots; account/gym scope required. | View queue/monitor history offline; add/edit/delete/simulate actions strictly online-only. | Source verified in `api.js`/`autobook.js`; no offline authenticated run. |
| Calendar settings and feed controls | **Implemented:** a sanitized account snapshot restores enabled state, generation and gym coverage. The subscribed `.ics` feed remains external to the PWA cache. | Feed links are stripped, so offline snapshot cannot offer copy/open actions; no snapshot gives explicit saved-status absence copy. | Add a stale indicator inside this panel if the global banner is insufficient in usability review. | Feed URL is a bearer-like secret and is excluded from snapshots. | Display stale enabled state only; enable/disable/refresh/rotate/copy actions online-only. | Mock Chrome snapshot key audit found no calendar-link fields. C4-8 covered Apple Calendar online, not this offline panel. |
| Settings, spot maps, notifications and account controls | **Implemented:** account/per-gym settings, studio preferences and normalized profiles/eligibility have account- and gym-qualified snapshots. Push subscription and account/password/profile write routes remain network-only. | No snapshot gives explicit offline explanatory copy for gym configuration. Theme already persists locally in `localStorage` without a server write. | Consider bounded retention and a device-lock requirement for spot preferences. | Spot preferences and notification settings are personal data. Password, tokens, VAPID subscriptions and exported configuration are excluded. | Theme remains locally switchable; all server writes, export/import, push subscription and password change are online-only. | Mock Chrome created per-Psycle/JAB settings/preferences/profile snapshots; iOS push behaviour was not re-run. |
| Instructor photos | Same-origin `/api/instructor-photo/*` WebP responses cache-first in bounded `sweat-images-v2` (160 entries); image failure falls back to initials. | Photos absent from cache show initials offline; this is safe but not disclosed. | Keep cache-first and initials fallback; consider prewarming only visible timetable/bookings avatars after consented online load. | Faces are personal data. Bound size/count, do not cache third-party opaque responses, purge alongside account if provider policy requires it. | Read-only. | Real Chrome: eight cached photo entries and loaded 96px images from Psycle/JAB. Aarmy photo cache not tested. |
| Gym logos, chips and Aarmy assets | Same-origin `/gyms/` assets are cache-first and are now installed with the built shell; SVG wordmarks are also fetched into an in-memory inline sprite. `gyms.config.js` gives Psycle/JAB SVG and Aarmy PNG full/compact/mark assets. | **Implemented:** cached shell has every current brand file, avoiding first-render chip/header gaps after an installed worker. Text initials remain the fallback if install/storage is absent; Aarmy PNG still cannot use the sprite. | Retain initials fallback and test image decode on iOS. | Brand assets are public. Do not use remote provider assets. | Read-only. | Built-preview Chrome cache contained JAB/Aarmy assets. C10 target-environment cache-clear acceptance remains outstanding. |
| Event detail, studio layout, cancellation penalty and overlap checks | Network-only GET/POST paths. Studio layout has process/client render caches only after it is fetched. | Opening an uncached detail or spot map offline fails; a cached timetable cannot fully explain an action. | Persist only read-only event/layout snapshots needed for viewed classes, with capped size and expiry. Do not invent penalty/overlap results. | Floor plans and current availability can be sensitive/stale. Bind records to gym and event IDs. | Display cached detail labelled stale; any availability, penalty or overlap check and every resulting write online-only. | Source verified in `api.js`; no offline browser test. |
| Booking, waitlist, swap, bookmarks, checkout and admin-like writes | POST/PUT/DELETE/PATCH routes are network-only. CSS disables named controls when `.psycle-offline` is set and `apiFetch()` now has a shared network-write guard. | **Implemented:** confirmed offline state rejects mutations before any fetch; a false-negative connection can still fail at the network layer, as intended. There is no write queue. | Add disabled/ARIA state where individual controls need a specific explanation; do not queue bookings, cancellation, payment, link/unlink or calendar rotation. | These actions can spend credits, lose places or rotate secrets. Never replay them automatically. | Always online-only; show why and provide retry only after a fresh connection check. | Guard unit tests passed. No mutation was attempted in Chrome. |

## Platform constraints and implementation decisions to preserve

- iOS Home Screen PWAs do not supply Background Sync for a reliable write queue. The server,
  rather than the client, already owns unattended Auto-Book/Upgrade work. The safe offline
  contract is therefore **read-only cached data plus explicitly blocked writes**.
- iOS may evict CacheStorage/IndexedDB under storage pressure. Cache is an enhancement, never a
  source of truth; empty cache must render a useful offline state instead of a blank shell.
- The service worker must continue to cache only same-origin, inspectable photo/asset responses.
  The current F-15 provider-photo proxy and its bounded cache should remain the image boundary.
- No fallback may collapse gym scope: an event, booking, profile, logo, preference or cached
  capability must retain both account and `gymId`. This includes the disabled Aarmy tenant once it
  is enabled.

## Required verification before any implementation is marked complete

1. Use a disposable authenticated mock account plus the real Chrome profile: load every tab,
   capture `last synced`, go offline, relaunch, and prove the matrix's cached and unavailable
   states. Clear service worker, CacheStorage and IndexedDB between cold-install cases.
2. Run the same non-destructive flow on an installed iPhone/iPad PWA for Psycle/JAB. Add Aarmy
   only under C10's activation boundaries and repeat after its target deployment.
3. Exercise one representative mutation per category while offline (booking, cancel, waitlist,
   link/unlink, settings, calendar, push) without sending it; assert no request or local success
   is emitted. Reconnect and verify no deferred mutation appears.
4. Run `npm test`, then record browser evidence in the relevant workstream. Existing C4-7 and
   C10 statuses must only be changed by their owning acceptance work.

## Independent review and re-test — 2026-10-02

- Reviewed the offline foundation, snapshot consumers, mutation guard, generated service worker,
  gym presentation and instructor-photo changes. No additional concrete regression was reproduced,
  so no code was changed in this review. Snapshot keys require the authenticated user prefix;
  gym-specific profile, eligibility, settings and studio-preference snapshots include the gym id.
  The recursive sanitizer strips sensitive key names and the complete calendar `links` object.
- Full `npm test` passed: **57/57 server suites** and **28/28 client files, 205/205 tests**.
  `npm run build:client` completed; `node --check client/dist/sw.js` passed. The generated worker
  contains the build stamp and precache paths for all four hashed JS/CSS files and ten gym assets.
- Real Chrome 154, disposable local mock account (`dev@psycle.com`, with local JAB mock), on
  2026-10-02: authenticated online render showed Psycle and JAB timetable rows. After offline
  emulation and reload, the controlled page retained those rows and displayed the saved-data time
  and disabled-change notice. Calling `api.book()` with a no-op audit event id rejected with
  `OFFLINE_MUTATION_BLOCKED`; CDP observed zero `/api/book` requests. No gym booking was attempted.
- A second disposable Chrome origin served the production build through a local API proxy. After
  the worker installed, an offline reload rendered the cached onboarding shell and loaded the
  hashed entry JS/CSS. This checks an installed worker's shell cache, not a first-ever offline
  install or storage eviction. The proxy harness did not complete an authenticated built-app
  render, so authenticated cold-start and built-app data fallback remain unverified there.
- Remaining acceptance limits: installed iOS/iPadOS behavior; cold launch with an expired token;
  full offline coverage of every tab and write category; actual JAB/Aarmy provider-photo delivery;
  Aarmy remains disabled and no live Aarmy API was contacted. Existing C4-7 and C10 evidence/status
  is unchanged. The client/server source and unit suites support JAB/Aarmy image URL handling, but
  do not replace those live/browser checks.

## JAB/Aarmy image reliability audit — 2026-10-02

- **JAB provider data and proxy: passed in real Chrome on the authenticated dev twin.** A JAB
  timetable instructor (id `6438`) opened a same-origin full image at
  `/api/instructor-photo/jab-boxing/6438?...`; it decoded as 480×480 WebP. A cache-reload request
  returned `200`, `X-Instructor-Photo-Cache: HIT`, an immutable one-year `Cache-Control` value,
  and a versioned ETag. This establishes that a missing JAB avatar is not a general MarianaTek
  provider-data or proxy-cache failure.
- **Addressed source-normalisation failure:** metadata may be assembled from a MarianaTek event
  whose image URLs are already proxy URLs. Re-hashing that proxy URL produced a `v` value which
  could never equal a provider-source hash, so the photo route returned 404. `photoProxyUrl()` now
  retains the existing version and changes only the requested size. The focused instructor-photo
  suite covers this exact re-normalisation path.
- **Aarmy:** Chrome loaded both public brand PNGs (`/gyms/aarmy-logo.png` and
  `/gyms/aarmy-mark.png`) successfully from the authenticated dev twin, and the production build
  precaches both. Aarmy remains disabled, and direct Aarmy timetable access returned 401 in this
  session, so no claim is made about live Aarmy provider photos, image headers, or its disk cache.
- **Offline boundary:** `sweat-images-v2` caches only same-origin successful proxy responses and
  caps them at 160 entries. Missing or evicted photos fall back to initials; this is an iOS
  CacheStorage retention limit, not a provider-image defect. The built service worker includes JAB
  SVG and Aarmy PNG assets, but target-device iOS decoding and storage-eviction behaviour remain
  C10 acceptance work.
- **Focused checks:** `node server/test-instructor-photo.js` (6/6), `node server/test-adapters.js`
  (40/40), `npm run test:client` (28 files, 205 tests), `npm run build:client`, and
  `node --check client/dist/sw.js` all passed. The build includes both Aarmy asset paths in the
  worker precache list.

## Final sequential re-audit — 2026-10-02

- **Root cause found in local dev read setup:** dev login selected one mock email per provider,
  although JAB and Aarmy each configure a distinct `mockEmail`. Aarmy therefore failed to link
  under the dev account and was absent from the merged timetable. `server/auth.js` now uses each
  gym's configured mock identity and keeps Aarmy automatic seeding opt-in via
  `AARMY_ENABLED=true`; the default Psycle/JAB test fixture remains unchanged.
- **Read evidence:** before adding the final opt-in gate, Chrome showed Psycle, JAB and Aarmy
  timetable rows in the local mock run. The server logged MarianaTek mock `GET /classes` and
  `GET /me/reservations` for JAB and Aarmy. `api.getBookings()` and `api.getWaitlists()` completed;
  the mock returned Psycle booking rows and no JAB/Aarmy booking rows. The final `AARMY_ENABLED=true`
  automatic-seed path was not re-run in Chrome. No booking or other gym mutation ran. No live gym
  API was contacted; production Aarmy acceptance and live credentials remain unavailable to this
  audit.
- **Offline rerun boundary:** this pass saw the local snapshots store populated and the offline
  banner on a controlled page, but could not complete a final warm/no-snapshot UI reload after a
  second `sweat-dev.wingfield.tech` tab appeared in Chrome. CDP reported `offline: false` while
  the local tab still reported `navigator.onLine === false`; per the one-tab/browser etiquette,
  no further network emulation was applied. The earlier disposable-tab evidence above remains the
  recorded offline reload evidence; installed iOS, cold launch, and the no-snapshot bookings UI
  state remain unverified in this final pass.
- **Final checks after the auth change:** `npm test` passed 57/57 server suites and 28/28 client
  files (205/205 tests). `npm run build:client`, source and generated worker syntax checks, and
  `git diff --check` passed. The build emitted Vite's existing mixed static/dynamic import
  chunking warnings; it completed successfully.
