# AGENTS.md — Psycle PWA

## What This Is

Server + PWA migration of the [Psycle Chrome Extension](https://github.com/piersjones/psycle-chrome). The extension's scheduling features (auto-book, auto-upgrade) currently require an open browser tab; this project moves them to a server so they run 24/7 and adds iOS support via PWA.

**Status**: Active development. Server and PWA are functional with core features working. See Feature Parity section below.

## Key Reference

- `PROJECT.md` — Complete architecture, API reference, data structures, auth flow, migration plan. Read this first.
- Parent `../browser_extension/` — Chrome Extension source code (the system being ported). Key files:
  - `content.js` (~10k lines) — All extension UI and logic, runs in ISOLATED world
  - `interceptor.js` — Network interceptor + Vue bridge, runs in MAIN world
  - `styles.css` (~3.2k lines) — Liquid glass UI styles
  - `manifest.json` — V3 manifest, content script config
- Parent `../api_documentation.md` — CodexFit API endpoint reference
- Parent `../website_function_documentation.md` — How the native website renders the timetable

## Project Structure

```
App/
├── server/                  # Express.js backend
│   ├── server.js            # Main server — routes, proxy, cart endpoints
│   ├── auth.js              # CodexFit login, JWT issuance, auto-relogin
│   ├── db.js                # SQLite schema + CRUD (better-sqlite3)
│   ├── crypto.js            # AES-256-GCM encrypt/decrypt for credentials
│   ├── scheduler.js         # Monday 12PM London auto-book precision scheduler
│   ├── poller.js            # Auto-upgrade polling engine (1min/15min/1hr)
│   ├── push.js              # Web Push (VAPID) notification service
│   └── test-auth-and-proxy.js  # Basic integration tests
├── client/                  # Vite PWA frontend
│   ├── index.html           # SPA shell with all tab panels
│   ├── src/
│   │   ├── main.js          # App init, auth, tab routing, push registration
│   │   ├── api.js           # API abstraction layer (all server calls)
│   │   ├── lib.js           # Shared utilities (Luxon timezone, countdown)
│   │   ├── styles.css       # Glassmorphic dark theme (~3650 lines)
│   │   └── ui/
│   │       ├── timetable.js   # Class timetable, filters, booking, floor plans
│   │       ├── bookings.js    # My Bookings + Waitlists + Auto-Upgrade setup
│   │       ├── autobook.js    # Auto-Book queue + countdown
│   │       ├── autoupgrade.js # Auto-Upgrade monitor list
│   │       ├── credits.js     # Buy Credits bundle cards + cart
│   │       ├── settings.js    # Settings pane (booking, upgrade, push, export)
│   │       └── tooltips.js    # Instructor + occupancy hover tooltips
│   └── public/
│       ├── manifest.json    # PWA manifest
│       ├── sw.js             # Service worker (push + offline caching)
│       └── icons/            # App icons (128, 192, 512)
├── Dockerfile               # Multi-stage build (client → server/public)
├── docker-compose.yml       # Single-container deployment
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

## Critical CodexFit API Gotchas

- **No token refresh endpoint exists.** When the JWT expires, the only option is re-auth via `POST /auth/login` or `POST /auth/multipass/login`. The server handles this automatically via `triggerAutoRelogin()`.
- **Direct login** (`POST /api/v1/customer/auth/login` with `{ email, password }`) works but is not used by the website (which uses Shopify multipass SSO). This is the key enabler for the PWA.
- **Required headers** on all CodexFit requests: `origin: https://psyclelondon.com`, `referer: https://psyclelondon.com/`, `accept: application/json`, `x-organisation: [object Object]` (yes, literally the string `[object Object]`).
- **Booking window**: Rolling Monday 12:00 PM London time release. `booking_cutoff` and `extended_cutoff` fields on user profile control access. `is_always_bookable` bypasses cutoffs.
- **Bookmark identifier formula**: `studioId + "0000" + dayOfWeek + "0000" + HHmm` (e.g., studio 138, Monday 19:30 → `"1380000100001930"`).
- **Cart API**: `GET /cart/add_bundle/{bundleId}?instance={instanceId}` adds bundles to a CodexFit cart. The instance ID is created via `POST /cart` and stored in user settings.

## Architecture Constraints

- **Server must handle all background work** (auto-book scheduling, auto-upgrade polling). The PWA is just a UI + push notification receiver.
- **Auto-book precision**: Targets Monday 12:00 PM London time with T-30s prefetch and T-0 dispatch. Server-side `setTimeout` replaces the extension's 200ms `setInterval`.
- **Auto-upgrade**: Configurable polling (1min/15min/1hr). Stops monitoring at 12h before class start.
- **Credential storage**: AES-256-GCM encryption at rest. Server-side key in env vars, never in DB.
- **PWA must work on iOS 16.4+** via "Add to Home Screen". No background sync on iOS — server handles everything.
- **Timezone**: All cutoff/release calculations must use `Europe/London` timezone. The server uses Luxon; the client uses Luxon via `src/lib.js`. Never use bare `new Date()` for booking window math.

## Feature Parity Status

| Feature | Extension | PWA | Notes |
|---------|-----------|-----|-------|
| Login/Auth | Cookie-based | ✅ Server BFF + JWT | Direct login + auto-relogin on 401 |
| Timetable | Full grid | ✅ Working | Filters, date carousel, status badges |
| Studio floor plan | Hover minimap | ✅ Working | Tooltip + booking modal |
| Instructor tooltip | Photo + bio | ✅ Working | Hover tooltip |
| Quick Book | Single slot | ✅ Working | With seat selection |
| Auto-Book | 200ms interval | ✅ Working | Server-side precision scheduler |
| Auto-Upgrade | setInterval polling | ✅ Working | Server-side cron + 12h cutoff |
| My Bookings | Table + cancel | ✅ Working | With penalty warning |
| Waitlists | Join/leave | ✅ Working | |
| Bookmarks | ♡/♥ toggle | ✅ Working | Native CodexFit bookmarks |
| Buy Credits | Bundle table + cart | ✅ Working | Cart add via CodexFit API → redirect to website |
| Settings | All toggles | ✅ Working | Booking, upgrade, push, export/import, debug, prefetch weeks |
| Debug Mode | Raw JSON diagnostics | ✅ Working | Toggle in Settings, debug button on rows |
| Push Notifications | N/A | ✅ Working | VAPID, auto-generated keys |
| Config Export/Import | JSON file | ✅ Working | Chrome Extension compatible format |
| Smart Caching | 4hr TTL | ✅ Working | 4hr TTL with Monday 12PM force-refresh |
| Prefetch Weeks Setting | Configurable | ✅ Working | 1-8 weeks dropdown in Settings |
| Multi-slot Booking | Up to 4 slots | ⚠️ Partial | UI shows qty in auto-book modal only |

## Known Bugs / Issues

- **`window.switchTab`** — Was not exposed globally, breaking "Buy Credits" button in timetable. Fixed (added `window.switchTab = switchTab`).
- **Client timezone** — `getClassReleaseTime` was using `new Date()` without London timezone. Fixed by using Luxon via `src/lib.js`.
- **`deploy.sh`** — Had hardcoded Pi credentials. Fixed by using environment variables.
- **`autobook.js` duplicate export** — Had both `export async function initAutoBook` and `export { initAutoBook }`. Fixed by removing the duplicate.
- **Inline styles** — Many UI elements use inline `style=` attributes instead of CSS classes, making maintenance harder. Should be refactored over time.

## Server API Routes

```
POST   /api/auth/login              # Login → CodexFit BFF, returns local JWT
GET    /api/auth/status             # Check local JWT validity
POST   /api/cart/create             # Create CodexFit cart instance
POST   /api/cart/add-bundle/:id     # Add bundle to cart
GET    /api/cart                    # Get current cart
GET    /api/auto-book               # List user's auto-book queue
POST   /api/auto-book               # Add to auto-book queue
PUT    /api/auto-book/:id            # Update auto-book preferences
DELETE /api/auto-book/:id            # Remove from auto-book queue
GET    /api/auto-upgrade            # List user's auto-upgrades
POST   /api/auto-upgrade            # Set up auto-upgrade
DELETE /api/auto-upgrade/:id         # Cancel auto-upgrade
GET    /api/settings                 # Get user settings
PUT    /api/settings                 # Update user settings
GET    /api/studio-preferences       # Get all studio preference maps
PUT    /api/studio-preferences/:id   # Update studio preference map
GET    /api/config/export            # Export all preferences as JSON
POST   /api/config/import            # Import preferences from JSON
GET    /api/push/vapid-public-key    # Get VAPID public key
POST   /api/push/subscribe           # Register push subscription
POST   /api/push/unsubscribe         # Unregister push subscription
POST   /api/push/test                # Send test push notification
GET    /api/proxy/*                  # Proxy to CodexFit with stored JWT
```

## Storage Keys (Extension → PWA Mapping)

| Extension Key | Purpose | PWA Equivalent |
|---------------|---------|----------------|
| `psycleSettings` | User preferences | Server `/api/settings` |
| `psycleAutoBookings` | Auto-book queue + history | Server `/api/auto-book` |
| `psycleAutoUpgrades` | Auto-upgrade state | Server `/api/auto-upgrade` |
| `psycleStudioPreferences` | Per-studio slot maps | Server `/api/studio-preferences` |
| `psycleCacheData` / `psycleCacheTime` | Timetable cache (8hr TTL) | Not yet implemented |
| `psycleFavorites` | Bundle favorites | `localStorage` |
| `codex-cart` | Cart instance ID (sniffed) | Server `/api/cart` + user settings |
| `psycleUnlocked` | MD5 gatekeeper state | Removed (not needed) |