# AGENTS.md — Psycle PWA

## What This Is

Server + PWA migration of the [Psycle Chrome Extension](https://github.com/piersjones/psycle-chrome). The extension's scheduling features (auto-book, auto-upgrade) previously required an open browser tab; this project moves them to a server so they run 24/7 and adds iOS support via PWA + Web Push.

**Status**: Server and PWA are functional and deployed. All core features working — auto-book (server-side precision scheduler with priority tiers), auto-upgrade (cron polling), quick-book, timetable, bookings, buy credits (in-app Stripe checkout), push notifications (5 types), shared spot maps, calendar feed (.ics via webcal/Google), first-run onboarding, offline support, pull-to-refresh, admin panel, per-user rate limiting. See Feature Parity section for details.

## Key Reference

- `Documentation/PROJECT.md` — Complete architecture, API reference, data structures, auth flow, migration plan. Read this first.
- `Documentation/EXTENSION_SPEC.md` — Feature-by-feature spec of the Chrome extension with exact logic and copy. The PWA must replicate this (function, UX, logic, and wording).
- `Documentation/marianatek.md` — Mariana Tek platform research, feature gap analysis, multi-provider architecture plan, and level-of-effort estimate for supporting studios on Mariana Tek.
- Parent `../browser_extension/` — Chrome Extension source code (the system being ported). Key files:
  - `content.js` (~10k lines) — All extension UI and logic, runs in ISOLATED world
  - `interceptor.js` — Network interceptor + Vue bridge, runs in MAIN world
  - `styles.css` (~3.2k lines) — Liquid glass UI styles
  - `manifest.json` — V3 manifest, content script config
- `Documentation/api_documentation.md` — CodexFit API endpoint reference
- `Documentation/website_function_documentation.md` — How the native website renders the timetable

## Project Structure

```
App/
├── server/                  # Express.js backend
│   ├── server.js            # Main server — routes, proxy, cart/checkout, SSE, rate limiters
│   ├── auth.js              # CodexFit login, JWT issuance, auto-relogin on 401
│   ├── db.js                # SQLite schema + CRUD (better-sqlite3, 12 tables)
│   ├── crypto.js            # AES-256-GCM encrypt/decrypt for credentials (env key required)
│   ├── scheduler.js         # Monday 12PM London auto-book precision scheduler, priority tiers, SSE
│   ├── poller.js            # Auto-upgrade polling + cancellation/window reminders + cache refresh
│   ├── push.js              # Web Push (VAPID) notification fan-out service
│   ├── notifications.js     # Notification dispatch layer (5 types, per-user prefs)
│   ├── calendar.js          # iCalendar (.ics) feed generation, token auth, 3-hourly poll
│   ├── admin.js             # Admin panel API router (user list, detail, priority tiers, delete)
│   ├── admin.html           # Standalone admin SPA served at /admin
│   ├── config.js            # Central env config (appName, publicHost) — single source of truth
│   ├── mock.js              # Dev-mode mock CodexFit API (dev@psycle.com)
│   └── test-auth-and-proxy.js  # Basic integration tests
├── client/                  # Vite PWA frontend
│   ├── index.html           # SPA shell with 5 tab panels + modals + iOS bottom nav
│   ├── src/
│   │   ├── main.js          # App init, auth, tab routing, push, theme, offline, pull-to-refresh, credit badge
│   │   ├── api.js           # API abstraction layer (all server calls)
│   │   ├── lib.js           # Shared utilities (Luxon timezone, countdown, release time, booking-window detect)
│   │   ├── cache.js         # IndexedDB v2 wrapper (cache + api-responses stores, per-user key prefix)
│   │   ├── config.js        # Build-time + runtime app config (appName, publicHost via /api/config)
│   │   ├── styles.css       # Design tokens + glassmorphic theme, light/dark parity (~4900 lines) — the only stylesheet loaded
│   │   └── ui/
│   │       ├── timetable.js   # Class timetable, filters, booking modal, quick-book, floor plan, mobile cards
│   │       ├── bookings.js    # My Bookings + Waitlists + Auto-Upgrade setup + edit-spots modal
│   │       ├── autobook.js    # Auto-Book queue, countdown, SSE stream, favourites, edit modal
│   │       ├── autoupgrade.js # Auto-Upgrade monitor list (rendered in Auto-Book tab)
│   │       ├── credits.js     # Buy Credits bundle cards, filters, in-app cart + Stripe checkout
│   │       ├── settings.js    # Settings pane (4 subnav sections), Profile Explorer, Spot Maps, notif prefs, calendar card
│   │       ├── spotmap.js     # Shared studio floor-plan editor (reused by bookings/timetable/settings/autobook/upgrade)
│   │       ├── tooltips.js    # Instructor + occupancy tooltips (hover + touch tap-to-toggle)
│   │       ├── onboarding.js  # First-run 6-step guided flow (intro → install → login → notifs → calendar → spot maps)
│   │       ├── pulltorefresh.js # Reusable pull-to-refresh for scroll containers
│   │       └── cards.js       # Shared SVG icon set + discipline tags + card text helpers
│   └── public/
│       ├── manifest.json    # PWA manifest (name: "Psycle Assistant", standalone, portrait)
│       ├── sw.js             # Service worker (push + offline cache, network-first shell, cache-first assets)
│       └── icons/            # App icons (128, 192, 512 — any + maskable)
├── Dockerfile               # Multi-stage build (client → server/public)
├── docker-compose.yml       # Single-container deployment (port 3005→3000)
├── deploy.sh                # Pi deployment script (SSH + rsync + docker compose)
└── package.json             # Root workspace (concurrently dev server + client)
```

## Dev Commands

```bash
npm run install:all          # Install all dependencies
npm run dev                  # Start server + client concurrently (dev mode)
npm run dev:server           # Start server only (port 3000)
npm run dev:client           # Start Vite dev server only (port 5173, proxies /api)
npm run build:client         # Production build of client
npm start                    # Production start (server serves built client)
```

Server runs on port 3000. Vite dev server proxies `/api` to `localhost:3000`.

**Dev mode**: Login with `dev@psycle.com` (any password) to use `mock.js` — no CodexFit calls, realistic fake data (4 locations, 4 studios, 28 classes, 3 bundles). No mock for booking/waitlist/cancel actions.

## Critical CodexFit API Gotchas

- **No token refresh endpoint exists.** When the JWT expires, the only option is re-auth via `POST /auth/login` or `POST /auth/multipass/login`. The server handles this automatically via `triggerAutoRelogin()`.
- **Direct login** (`POST /api/v1/customer/auth/login` with `{ email, password }`) works but is not used by the website (which uses Shopify multipass SSO). This is the key enabler for the PWA.
- **Required headers** on all CodexFit requests: `origin: https://psyclelondon.com`, `referer: https://psyclelondon.com/`, `accept: application/json`, `x-organisation: [object Object]` (yes, literally the string `[object Object]`).
- **Booking window**: Rolling Monday 12:00 PM London time release. `booking_cutoff` and `extended_cutoff` fields on user profile control access. `is_always_bookable` bypasses cutoffs.
- **Booking offset**: Standard window is 8 days from Monday noon (Mon → following Tue); membership tiers extend it (2wk→15, 3wk→22). **Auto-detected** per user from profile `booking_cutoff`/`extended_cutoff` + `extended_booking_allowed`. Holding **extended-booking credits** in inventory applies a 15-day (2-week) *floor* — not additive: credits never extend an already-extended account or stack to a 3rd week. See `detectBookingWindow()` in `client/src/lib.js`, persisted to `settings.detectedBookingOffset` by `syncDetectedBookingWindow()` in `main.js`. `getBookingOffset()` priority: debug `manualBookingWindowWeeks` override (Settings, debug only) → `detectedBookingOffset` → legacy `advancedBooking`/`advancedBookingCredit` toggles. Mirrored in `server/scheduler.js` and `client/src/lib.js`.
- **Bookmark identifier formula**: `studioId + "0000" + dayOfWeek + "0000" + HHmm` (e.g., studio 138, Monday 19:30 → `"1380000100001930"`).
- **Cart API**: `POST /cart/add_bundle/{bundleId}?instance={instanceId}` adds bundles to a CodexFit cart. The instance ID is created via `POST /cart` and stored in user settings (`cartInstanceId`). The PWA's in-app checkout wraps this: `POST /api/cart/checkout/init/:bundleId` (add bundle + list saved cards) → `POST /api/cart/checkout/confirm` (place order, poll Stripe `GET /orders/:id` until `Paid`). When a saved-card charge requires 3-D Secure, the server returns `status: 'requires_action'` and the client falls back to the website checkout with tips (full in-app 3DS challenge flow not yet built — see BACKLOG.md).
- **Booking response shape**: `POST /bookings` returns `{ success: true, bookings: { "8255409": 53 } }` — the key is the booking ID, value is the slot ID. The client's `tryAutoRegisterUpgrade` extracts the booking ID from this.
- **No booking show/update endpoint**: `GET /bookings/{id}` and `PUT/PATCH /bookings/{id}` all return HTTP 500 `BadMethodCallException` (`BookingController::show`/`::update` does not exist). The routes exist (Laravel `Route::resource` boilerplate) but the methods are unimplemented. `BookingController` only implements `index` (list), `store` (create), `destroy` (cancel). **There is no atomic spot-swap API** — changing spots requires cancel-then-rebook (`DELETE /bookings/{id}` + `POST /bookings`). Confirmed via authenticated API testing; see `api_documentation.md` "Spot Swapping (Confirmed Not Supported)".

## Architecture Constraints

- **Server must handle all background work** (auto-book scheduling, auto-upgrade polling, reminders, calendar feed polling). The PWA is just a UI + push notification receiver.
- **Auto-book precision**: Targets Monday 12:00 PM London time with T-50s staggered prefetch and T-0 dispatch. Server uses `setTimeout` → T-5s → `setInterval` every 10ms polling `Date.now()` until `>= targetRelease`. Replaces the extension's 200ms `setInterval`.
- **Priority tiers + fair dispatch**: `users.priority` (lower = higher precedence; default 100, new users get 200) drives Monday-noon dispatch ordering. `getPendingAutoBookings()` JOINs `users.priority` and sorts `ORDER BY priority ASC, created_at ASC`; Fisher-Yates shuffle within each tier gives statistical fairness over weeks. `CLAIM_STAGGER_MS = 80ms` staggers consecutive users in the same class. Cross-user `claimedSlots`/`burnedSlots` Sets prevent duplicate `POST /bookings` across concurrent users targeting the same event/slot. Admin-editable via `PUT /api/admin/users/:id/priority`.
- **Auto-upgrade**: Configurable polling (1min/15min/1hr) via `node-cron` every minute. Stops at 12h before class start (or one final "keep original" attempt if `keepOriginalOnCutoff`). Hard stop at 1h.
- **Rate limiting**: Five `express-rate-limit` limiters (production-only, skipped in dev): `proxyLimiter` (60/min per user on `/api/proxy/*`), `bookingMutationLimiter` (10/min per user on auto-book/upgrade writes), `calendarFeedLimiter` (60/min per IP on the public calendar URL), `authLoginLimiter` (10/15min per IP on `/api/auth/login`), `adminLoginLimiter` (5/15min per IP on `/api/admin/login`). Per-user quotas cap auto-book at 15 pending entries and auto-upgrade at 10 active monitors (429 on exceed).
- **CORS**: Browser-origin allowlist (`config.corsOrigins`, override via `CORS_ORIGINS`). The PWA is served same-origin in production, so only the public host is allowed; localhost dev origins are added when `NODE_ENV !== 'production'`. Requests with no `Origin` header (curl, native calendar clients, same-origin nav) pass through; disallowed origins get no CORS headers (browser blocks them) rather than a 500.
- **Admin auth**: `/api/admin/login` compares the password in constant time (`crypto.timingSafeEqual` over SHA-256 digests) to avoid timing leaks, and is brute-force-limited (5/15min per IP).
- **Credential storage**: AES-256-GCM encryption at rest. Master key MUST come from the `ENCRYPTION_KEY` env var — the server refuses to start if it is absent (no DB fallback). Never in DB as plaintext.
- **Calendar feed**: Per-user rotatable token (`users.calendar_token`) authenticates the public `.ics` URL. A 3-hourly cron polls CodexFit bookings/waitlists and regenerates each enabled user's snapshot; booking mutations trigger a debounced (60s) refresh. RFC 5545 serialization with `Europe/London` VTIMEZONE and optional VALARM.
- **Admin panel**: Standalone SPA at `/admin`, gated by `ADMIN_PASSWORD` env var (503 if absent) + 1h admin JWT. Read-only user list/detail plus inline priority-tier editing and user deletion.
- **PWA must work on iOS 16.4+** via "Add to Home Screen". No background sync on iOS — server handles everything. Push notifications require the PWA to be installed to home screen. First-run onboarding guides install + login + notifications + calendar + spot maps.
- **Timezone**: All cutoff/release calculations must use `Europe/London` timezone. The server uses Luxon; the client uses Luxon via `src/lib.js`. Never use bare `new Date()` for booking window math.
- **Shared spot map**: One preference map per studio (`studio_preferences[studioId] = { preferredSlots[], preferredRows[] }`) is the single source of truth for Quick-Book, Auto-Book, and Auto-Upgrade. All three read it live from the server. The floor-plan editor in `spotmap.js` is reused everywhere the map is edited.

## Shared Spot Map Architecture

The PWA unifies what the extension kept as separate per-entry preferences. There is **one shared preferred spot map per studio**:

- **Storage**: `studio_preferences` SQLite table, keyed by `(user_id, studio_id)`, value is JSON `{ preferredSlots: number[], preferredRows: number[] }`.
- `preferredSlots` — ordered list of slot IDs (order = priority; badge shows 1, 2, 3…).
- `preferredRows` — list of row Y-coordinates (rounded to 0.1) representing whole-row preferences.
- **Editor**: `client/src/ui/spotmap.js` exports `renderStudioFloorPlan(container, layoutSlots, initialSlots, initialRows, onSave, options)` — reused by:
  - Settings → Manage Maps (`settings.js` → `openStudioFloorPlanEditor`)
  - Auto-Book/Quick-Book config modal (`timetable.js` → `openBookingModal`)
  - Auto-Upgrade config modal (`bookings.js` → `openUpgradeConfigModal`)
- **Live resolution**: The server's `scheduler.js` `resolveLiveMap()` reads the shared map at execution time. Auto-upgrade's `poller.js` reads it at each check. Per-entry preferences are no longer stored — only the shared map + per-monitor options (e.g. `keepOriginalOnCutoff`).

## Notification System

Five notification types, all server-side, all deduped via the `sent_notifications` SQLite table:

| Type | Triggered by | Condition | Default |
|------|-------------|-----------|---------|
| `booking` | `scheduler.executeAutoBookForClass` (auto-book success) or client `notifyBookingSuccess` (manual/quick-book) | `prefs.booking.enabled`; if `scope='autobook'` then only auto-book source | enabled, scope: all |
| `upgrade` | `poller.attemptUpgradeSlot` (upgrade success) | `prefs.upgrade.enabled` | enabled |
| `creditWarning` | `server.js` POST `/api/auto-book` or `/api/auto-upgrade` | `prefs.creditWarning.enabled` | enabled |
| `cancellationReminder` | `poller.checkCancellationReminders` (local timer, reads `booking_cache`) | `prefs.cancellationReminder.enabled`; fires at 24h or 14h before class, only inside free-cancel window | enabled, timing: 24h |
| `bookingWindow` | `poller.checkBookingWindowReminder` (weekly at Mon 11AM) | `prefs.bookingWindow.enabled`; contextual tip based on queue count + credits | enabled |

- **Dispatch**: `notifications.js` `notify(userId, type, ctx)` builds the body, checks user prefs, calls `push.js` `sendNotification()` which fans out to all `push_subscriptions` for the user. Expired subscriptions (410/404) are auto-deleted.
- **Dedupe**: `sent_notifications` table with `UNIQUE(user_id, dedupe_key)` — e.g. `cancel:123:24h`, `window:2026-06-22`.
- **Client prefs UI**: Settings → "Customise Notifications" modal (`settings.js` `renderNotifPrefs`) — per-type toggles + dropdowns for scope/timing.
- **Debug testing**: Settings → Test Notifications card (debug mode only) — 9 sample buttons via `POST /api/push/test/:type`.

## Health Check & Uptime Monitoring

The background services (auto-book scheduler, auto-upgrade poller, calendar feed) run as in-process timers/cron. A plain "is the port open?" check only proves Express is alive — the scheduler can silently die while HTTP keeps serving, and nobody notices until Monday bookings are missed. `GET /api/health` solves this with a **liveness heartbeat** per service.

- **How it works**: each service writes `heartbeat:<service>` (epoch-ms) to the `server_kv` table on a fixed cadence — scheduler every 60s (`setInterval` in `scheduler.init`), poller every 60s (inside its `* * * * *` cron), calendar every 3h (inside its `0 */3 * * *` cron). All three are seeded at `init()` so a freshly-booted server is immediately healthy.
- **The endpoint** (`server.js`, no auth) reads those heartbeats and compares each against its staleness limit (`HEARTBEAT_LIMITS`: scheduler/poller 180s, calendar 12600s/3.5h). It returns **HTTP 200** with `{ status: 'ok', ... }` when every service is fresh, and **HTTP 503** with `{ status: 'degraded', ... }` if any heartbeat is stale or missing. `nextReleaseAt` echoes the armed Monday-noon release so you can confirm a window is actually scheduled, not just that the process ticks.
- **Sample healthy response**:
  ```json
  { "status": "ok", "uptimeSec": 3, "nextReleaseAt": "2026-06-29T12:00:00.000+01:00",
    "services": { "scheduler": { "healthy": true, "lastHeartbeatAgoSec": 2, "staleAfterSec": 180 },
                  "poller":    { "healthy": true, "lastHeartbeatAgoSec": 2, "staleAfterSec": 180 },
                  "calendar":  { "healthy": true, "lastHeartbeatAgoSec": 2, "staleAfterSec": 12600 } } }
  ```

### Connecting a 3rd-party uptime monitor

Point any HTTP monitor at `https://<your-host>/api/health` and alert on **non-2xx** — the 503-on-degraded is the whole mechanism, so a status-code check is enough (no keyword/JSON parsing needed).

- **UptimeRobot / Better Uptime / Pingdom / Healthchecks.io**: create an *HTTP(s)* monitor, URL `https://<your-host>/api/health`, interval 5 min. These flag any 5xx as down by default, so a stale heartbeat → 503 → alert. Optionally add a keyword check for `"status":"ok"` for belt-and-braces.
- **Docker `HEALTHCHECK`** (in `Dockerfile` / `docker-compose.yml`):
  ```
  HEALTHCHECK --interval=60s --timeout=5s --retries=3 \
    CMD wget -qO- http://localhost:3000/api/health || exit 1
  ```
  (`wget`/`curl` exit non-zero on 503, marking the container unhealthy.)
- **Self-hosted cron on the Pi** (no external dependency): `*/5 * * * * curl -fsS https://<host>/api/health > /dev/null || <notify>` — `curl -f` returns non-zero on 503.

The endpoint is unauthenticated and leaks no user data (only service liveness + uptime), so it's safe to expose publicly to a monitor.

## Feature Parity Status

| Feature | Extension | PWA | Notes |
|---------|-----------|-----|-------|
| Login/Auth | Cookie-based | ✅ Working | Server BFF + JWT, direct login + auto-relogin on 401 |
| Timetable | Full grid | ✅ Working | Filters, date carousel, status badges, IndexedDB 4hr TTL cache |
| Studio floor plan | Hover minimap | ✅ Working | Occupancy tooltip + booking modal with spot selection |
| Instructor tooltip | Photo + bio | ✅ Working | Hover tooltip (1s delay) + touch tap-to-toggle; Instagram/Spotify links |
| Quick Book | Single slot | ✅ Working | One-click if prefs exist, else opens floor-plan modal |
| Auto-Book | 200ms interval | ✅ Working | Server-side precision scheduler + priority tiers + SSE live status stream |
| Auto-Upgrade | setInterval polling | ✅ Working | Server-side cron + 12h/1h cutoff + auto-register after booking |
| My Bookings | Table + cancel | ✅ Working | Penalty warning, double-click confirm, auto-upgrade toggle per row |
| Waitlists | Join/leave | ✅ Working | Join from timetable, leave from bookings, double-click confirm |
| Bookmarks | ♡/♥ toggle | ✅ Working | Native CodexFit bookmarks, "favourites only" filter |
| Buy Credits | Bundle table + cart | ✅ Working | Bundle cards, 8 filters, two-click cart → in-app Stripe checkout (website fallback for 3DS) |
| Settings | All toggles | ✅ Working | 4 subnav sections (About, Booking, Experience, Advanced): spot maps, upgrade, push, notif prefs, calendar, theme, export/import, debug, profile explorer, delete data |
| Debug Mode | Raw JSON diagnostics | ✅ Working | Per-class debug modal, debug log terminal, simulate release |
| Push Notifications | N/A | ✅ Working | VAPID, 5 types, per-user prefs, auto-generated keys |
| Config Export/Import | JSON file | ✅ Working | Chrome Extension compatible format |
| Smart Caching | 4hr TTL | ✅ Working | IndexedDB 4hr TTL with Monday 12PM force-refresh |
| Prefetch Weeks Setting | Configurable | ✅ Working | 1-8 weeks dropdown in Settings |
| Multi-slot Booking | Up to 4 slots | ✅ Working | Qty selector in quick-book + auto-book modal; multi-spot selection in simple book mode |
| Spot Map Editor | Per-studio | ✅ Working | Shared map editor in Settings, reused by all booking flows |
| Profile Explorer | N/A | ✅ PWA-only | Categorized CodexFit profile viewer + Konami-code edit mode |
| Notification Preferences | N/A | ✅ PWA-only | Per-type toggles + scope/timing dropdowns |
| Cancellation Reminders | N/A | ✅ PWA-only | 24h/14h before class, deduped, reads booking cache |
| Booking Window Reminder | N/A | ✅ PWA-only | 1hr before Monday release, contextual tip |
| SSE Live Status | N/A | ✅ PWA-only | Real-time auto-book execution updates via Server-Sent Events |
| Booking Cache Sync | N/A | ✅ PWA-only | Client pushes bookings to server for reminder cache |
| Calendar Feed | N/A | ✅ PWA-only | Per-user .ics feed (webcal/Google), token auth, 3-hourly poll, VALARM, Europe/London VTIMEZONE |
| First-run Onboarding | N/A | ✅ PWA-only | 6-step guided flow (intro → install → login → notifs → calendar → spot maps) |
| Offline Support | N/A | ✅ PWA-only | SW network-first shell + cache-first assets, offline banner, button disabling |
| Pull-to-refresh | N/A | ✅ PWA-only | Reusable pull-to-refresh on scroll containers (timetable, bookings, auto-book) |
| Theme Toggle | N/A | ✅ PWA-only | Auto/Light/Dark segmented control, persisted to localStorage |
| Admin Panel | N/A | ✅ PWA-only | Standalone SPA at /admin, user list/detail, priority-tier editing, delete |
| Rate Limiting + Quotas | N/A | ✅ PWA-only | 3 per-user limiters + auto-book (15) / auto-upgrade (10) quotas |
| Auto-Book Favourites | Syncs bookmarks → queue | ⚠️ Incomplete | UI saves favourite list to settings, but server doesn't auto-populate queue from it |
| .ics File Download | From My Bookings | ❌ Missing | Extension had `downloadICS`; PWA has a live calendar *feed* instead (no one-off file download) |
| Native timetable augmentation | Injected buttons | N/A | Extension-only; PWA is standalone |

## Known Bugs / Issues

- **Auto-Book Favourites incomplete** — The Auto-Book tab has a "♥ Auto-Book Favourites" modal that saves `autoBookFavourites` (a list of bookmark identifiers) to user settings, but nothing in `scheduler.js` consumes this list to auto-create queue entries each week. The extension's `syncBookmarkedAutoBookings` logic has not been ported.
- **Mobile/iOS layout still uses floating-panel heritage** — The root panel base is still `width: 1080px; max-height: 85vh; border-radius: 28px` (extension floating-panel heritage). Responsive media queries (`@media max-width: 1100px/480px`) now make it full-width on small screens and an iOS bottom nav was added, but the base dimensions mean it doesn't feel fully native on iOS installed to home screen. A dedicated mobile-first layout pass would improve this.
- **Inline styles everywhere** — UI modules build elements with large `style="..."` strings instead of CSS classes, making maintenance and responsive tweaks painful (can't media-query inline styles). `cards.js` extracts some shared helpers, but most modules still inline. Should be migrated to `styles.css` classes over time. (`styles.css` is the only stylesheet imported in `index.html`.)
- **3-D Secure not handled in-app** — In-app credit checkout charges a saved card off-session. When the charge requires 3-D Secure authentication, the server returns `status: 'requires_action'` and the client falls back to the website checkout with tips. The full Stripe.js `confirmCardPayment` challenge flow is not yet built (see BACKLOG.md).

## Server API Routes

```
# Public Config + Health (no auth)
GET    /api/config                # Returns { appName, publicHost } — needed before login to render UI
GET    /api/health                # Liveness probe — 200 when scheduler/poller/calendar heartbeats are fresh, 503 if any is stale

# Admin Panel
GET    /admin                     # Serves admin.html (standalone admin SPA)
POST   /api/admin/login           # Verify ADMIN_PASSWORD, issue 1h admin JWT
GET    /api/admin/users           # List all users with queue counts + priority
GET    /api/admin/users/:id       # Full user detail (profile, credits, bookings, queue, monitors, spot maps)
PUT    /api/admin/users/:id/priority  # Update a user's priority tier (1–999)
DELETE /api/admin/users/:id       # Delete user + all CASCADE data

# Auth
POST   /api/auth/login              # Login → CodexFit BFF, returns local JWT
GET    /api/auth/status             # Check local JWT validity
DELETE /api/auth/me                 # Delete all user data (account, creds, queue, prefs, push)

# CodexFit Proxy
ALL    /api/proxy/*                 # Proxy to CodexFit with stored JWT, auto-relogin on 401

# Auto-Book
GET    /api/auto-book               # List user's auto-book queue
POST   /api/auto-book               # Add to auto-book queue (triggers immediate-book check)
PUT    /api/auto-book/:id           # Update auto-book preferences
DELETE /api/auto-book/:id           # Remove from auto-book queue
POST   /api/simulate-release        # Debug: force-execute all pending bookings now
GET    /api/auto-book/stream        # SSE: real-time auto-book execution status (token via query param)

# Auto-Upgrade
GET    /api/auto-upgrade            # List user's auto-upgrade monitors
POST   /api/auto-upgrade            # Set up auto-upgrade (checks for duplicate active monitor)
PUT    /api/auto-upgrade/:id        # Update auto-upgrade (resets cutoffAttempted, sets active)
DELETE /api/auto-upgrade/:id        # Cancel auto-upgrade

# Settings & Preferences
GET    /api/settings                # Get user settings
PUT    /api/settings                # Update user settings
GET    /api/studio-preferences      # Get all studio preference maps
PUT    /api/studio-preferences/:id  # Update studio preference map

# Calendar Feed
GET    /api/calendar/:token.ics     # Public-by-token iCalendar feed (rate-limited 60/min by IP)
GET    /api/calendar/status         # Feed status, links, last-generated timestamp
POST   /api/calendar/enable         # Enable feed, generate/rotate token, rebuild snapshot
POST   /api/calendar/disable        # Disable feed, revoke token
POST   /api/calendar/rotate         # Rotate token + republish snapshot
POST   /api/calendar/refresh        # Debounced async refresh (60s delay)

# Backup & Migration
GET    /api/config/export           # Export all preferences as JSON
POST   /api/config/import           # Import preferences from JSON (deduplicates auto-book)

# Cart (Legacy + In-App Checkout)
POST   /api/cart/add-bundle/:id     # Add bundle to cart (legacy fallback)
POST   /api/cart/checkout/init/:bundleId  # In-app checkout step 1: add bundle + list saved cards
POST   /api/cart/checkout/confirm         # In-app checkout step 2: place order, poll Stripe, return status

# Push Notifications
GET    /api/push/vapid-public-key   # Get VAPID public key
POST   /api/push/subscribe          # Register push subscription
POST   /api/push/unsubscribe        # Unregister push subscription by endpoint
POST   /api/push/test               # Send generic test push
POST   /api/push/test/:type         # Send typed sample notification (debug)

# Notifications & Sync
POST   /api/notify/booking-success  # Client reports manual/quick booking → server fans out push
POST   /api/bookings/sync           # Client pushes bookings to warm server reminder cache
```

## SQLite Schema (12 tables)

| Table | Purpose | Key columns |
|-------|---------|-------------|
| `users` | Accounts + encrypted creds | `email`, `encrypted_password`, `jwt`, `jwt_expires_at`, `priority` (tier, default 100), `display_name`, `profile_json`, `calendar_token` |
| `auto_bookings` | Auto-book queue + history | `event_id`, `preferences` (JSON), `status`, `executed_at`, `studio_id`, `group_name` |
| `auto_upgrades` | Auto-upgrade monitors | `event_id`, `booking_id`, `current_slot_id`, `preferences` (JSON), `status`, `upgraded_slot_id`, `studio_id`, `original_slot_id` |
| `studio_preferences` | Shared spot maps | `studio_id`, `preferences` (JSON: `{preferredSlots[], preferredRows[]}`), `UNIQUE(user_id, studio_id)` |
| `settings` | Per-user settings | `preferences` (JSON blob — all settings + notification prefs + cartInstanceId) |
| `push_subscriptions` | Web Push endpoints | `subscription` (JSON string) |
| `booking_cache` | Reminder cache (client-synced) | `booking_id`, `event_id`, `start_at`, `slot_label`, `duration_min`, `location_address`, `UNIQUE(user_id, booking_id)` |
| `waitlist_cache` | Waitlist reminder cache (client-synced) | `event_id`, `start_at`, `studio_id`, `location_address`, `UNIQUE(user_id, event_id)` |
| `sent_notifications` | Notification dedupe | `dedupe_key`, `UNIQUE(user_id, dedupe_key)` |
| `calendar_classes` | Per-user calendar event rows | `event_id`, `start_at`, `class_name`, `slot_label`, `status`, `upgrade_note`, `sequence`, `content_hash`, `UNIQUE(user_id, event_id)` |
| `calendar_snapshots` | Generated .ics per user | `ics`, `etag`, `class_count`, `generated_at` (PK `user_id`) |
| `server_kv` | Key-value store | `jwt_secret`, `vapid_public_key`, `vapid_private_key`, `locations_json`, `studio_name_map` (`server_encryption_key` is legacy/unused — encryption key now env-only) |

## Storage Keys (Extension → PWA Mapping)

| Extension Key | Purpose | PWA Equivalent |
|---------------|---------|----------------|
| `psycleSettings` | User preferences | Server `/api/settings` (SQLite `settings` table) |
| `psycleAutoBookings` | Auto-book queue + history | Server `/api/auto-book` (SQLite `auto_bookings` table) |
| `psycleAutoUpgrades` | Auto-upgrade state | Server `/api/auto-upgrade` (SQLite `auto_upgrades` table) |
| `psycleStudioPreferences` | Per-studio slot maps | Server `/api/studio-preferences` (SQLite `studio_preferences` table) |
| `psycleCacheData` / `psycleCacheTime` | Timetable cache (8hr TTL) | IndexedDB `psycle-cache` store, 4hr TTL + Monday 12PM force-refresh |
| `psycleFavorites` | Bundle favorites | `localStorage` key `psycle-helper-favorites` |
| `codex-cart` | Cart instance ID (sniffed) | Server `/api/cart` + `settings.cartInstanceId` |
| `psycleUnlocked` | MD5 gatekeeper state | Removed (not needed) |

### PWA-only client-side storage

| Key | Location | Purpose |
|-----|----------|---------|
| `psycleLocalToken` | `localStorage` | Local JWT (30-day, issued by server BFF) |
| `psycleUserId` | `localStorage` | Per-user cache key prefix, set after login |
| `psycleTheme` | `localStorage` | Theme preference: `auto` \| `light` \| `dark` |
| `psycleDefaultFilters` | `localStorage` | Saved timetable filter selections (locations, instructors, eventTypes, bookmarks) |
| `psycleCacheEvents` / `psycleCacheMeta` | IndexedDB | Cached timetable events + metadata |
| `psycleCacheTime` | `localStorage` | Cache timestamp for TTL check |
| `psycleActiveStudioIds` / `psycleActiveStudioIdsTime` | `localStorage` | Active studio IDs for Spot Maps manager (24h TTL) |
| `psycleOnboardingComplete` | `localStorage` | Onboarding completion flag (value = version string) |
| `psycleOnboardingStep` | `localStorage` | Current onboarding step (resumable on iOS after install relaunch) |

IndexedDB database `psycle-cache` (v2) has two stores: `cache` (raw timetable events + metadata) and `api-responses` (all API GET response caching, per-user key prefix isolation).

## Environment Variables

| Variable | Used by | Purpose |
|----------|---------|---------|
| `PORT` | `server.js` | HTTP server port (default 3000) |
| `NODE_ENV` | `server.js` | If `production`, serves SPA static files |
| `DB_PATH` | `db.js` | SQLite database file path |
| `JWT_SECRET` | `auth.js`, `admin.js` | Secret for signing local PWA JWTs and admin JWTs (auto-generated + DB-stored fallback) |
| `ENCRYPTION_KEY` | `crypto.js` | **Required.** Master key for AES-256-GCM password encryption. Server refuses to start if absent (no DB fallback). |
| `VAPID_PUBLIC_KEY` | `push.js` | VAPID public key for Web Push (auto-generated + DB-stored fallback) |
| `VAPID_PRIVATE_KEY` | `push.js` | VAPID private key for Web Push (auto-generated + DB-stored fallback) |
| `VAPID_EMAIL` | `push.js` | `mailto:` VAPID contact (default: `mailto:admin@psycle.wingfield.tech`) |
| `ADMIN_PASSWORD` | `admin.js` | Password for admin panel login. If absent, all `/api/admin/*` routes return 503. |
| `APP_NAME` | `server/config.js` → all server modules + client via `/api/config` | App display name (default: `Psycle Assistant`). Server template-replaces static HTML/manifest/sw.js; client fetches `/api/config` for JS-rendered text. |
| `PUBLIC_HOST` | `server/config.js` → `calendar.js`, client via `/api/config` | Public domain for calendar feed URLs and UID generation (default: `psycle.wingfield.tech`). |
| `CORS_ORIGINS` | `server/config.js` → `server.js` | Comma-separated browser-origin allowlist for CORS. Defaults to `https://$PUBLIC_HOST` + `http://$PUBLIC_HOST`. Localhost dev origins are auto-added when `NODE_ENV !== 'production'`. |
