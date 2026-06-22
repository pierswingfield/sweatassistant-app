# AGENTS.md — Psycle PWA

## What This Is

Server + PWA migration of the [Psycle Chrome Extension](https://github.com/piersjones/psycle-chrome). The extension's scheduling features (auto-book, auto-upgrade) previously required an open browser tab; this project moves them to a server so they run 24/7 and adds iOS support via PWA + Web Push.

**Status**: Server and PWA are functional. All core features working — auto-book, auto-upgrade, quick-book, timetable, bookings, buy credits, push notifications, spot maps. See Feature Parity section for details.

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
│   ├── server.js            # Main server — routes, proxy, cart endpoints, SSE
│   ├── auth.js              # CodexFit login, JWT issuance, auto-relogin on 401
│   ├── db.js                # SQLite schema + CRUD (better-sqlite3, 8 tables)
│   ├── crypto.js            # AES-256-GCM encrypt/decrypt for credentials
│   ├── scheduler.js         # Monday 12PM London auto-book precision scheduler
│   ├── poller.js            # Auto-upgrade polling + cancellation/window reminders
│   ├── push.js              # Web Push (VAPID) notification fan-out service
│   ├── notifications.js     # Notification dispatch layer (5 types, per-user prefs)
│   ├── mock.js              # Dev-mode mock CodexFit API (dev@psycle.com)
│   └── test-auth-and-proxy.js  # Basic integration tests
├── client/                  # Vite PWA frontend
│   ├── index.html           # SPA shell with 6 tab panels + modals
│   ├── src/
│   │   ├── main.js          # App init, auth, tab routing, push registration, credit badge
│   │   ├── api.js           # API abstraction layer (all server calls)
│   │   ├── lib.js           # Shared utilities (Luxon timezone, countdown, release time)
│   │   ├── styles.css       # Glassmorphic dark theme (~4400 lines)
│   │   ├── panel-layout.css # Panel/tab/table/card layout + responsive (~970 lines)
│   │   └── ui/
│   │       ├── timetable.js   # Class timetable, filters, booking modal, quick-book, floor plan
│   │       ├── bookings.js    # My Bookings + Waitlists + Auto-Upgrade setup modal
│   │       ├── autobook.js    # Auto-Book queue, countdown, SSE stream, favourites
│   │       ├── autoupgrade.js # Auto-Upgrade monitor list (rendered in Auto-Book tab)
│   │       ├── credits.js     # Buy Credits bundle cards, filters, cart flow
│   │       ├── settings.js    # Settings pane, Profile Explorer, Spot Maps manager, notif prefs
│   │       ├── spotmap.js     # Shared studio floor-plan editor (reused by bookings/timetable/settings)
│   │       └── tooltips.js    # Instructor + occupancy hover tooltips
│   └── public/
│       ├── manifest.json    # PWA manifest
│       ├── sw.js             # Service worker (push + offline cache, network-first)
│       └── icons/            # App icons (128, 192, 512)
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
- **Booking offset**: Base 8 days from Monday noon. +7 days if `advancedBooking` setting, +7 more if `advancedBookingCredit` (max 22 days). Mirrored in `server/scheduler.js` and `client/src/lib.js`.
- **Bookmark identifier formula**: `studioId + "0000" + dayOfWeek + "0000" + HHmm` (e.g., studio 138, Monday 19:30 → `"1380000100001930"`).
- **Cart API**: `GET /cart/add_bundle/{bundleId}?instance={instanceId}` adds bundles to a CodexFit cart. The instance ID is created via `POST /cart` and stored in user settings (`cartInstanceId`).
- **Booking response shape**: `POST /bookings` returns `{ success: true, bookings: { "8255409": 53 } }` — the key is the booking ID, value is the slot ID. The client's `tryAutoRegisterUpgrade` extracts the booking ID from this.

## Architecture Constraints

- **Server must handle all background work** (auto-book scheduling, auto-upgrade polling, reminders). The PWA is just a UI + push notification receiver.
- **Auto-book precision**: Targets Monday 12:00 PM London time with T-30s prefetch and T-0 dispatch. Server uses `setTimeout` → T-5s → `setInterval` every 10ms polling `Date.now()` until `>= targetRelease`. Replaces the extension's 200ms `setInterval`.
- **Auto-upgrade**: Configurable polling (1min/15min/1hr) via `node-cron` every minute. Stops at 12h before class start (or one final "keep original" attempt if `keepOriginalOnCutoff`). Hard stop at 1h.
- **Credential storage**: AES-256-GCM encryption at rest. Server-side key in env vars (`ENCRYPTION_KEY`), falls back to DB key-value store. Never in DB as plaintext.
- **PWA must work on iOS 16.4+** via "Add to Home Screen". No background sync on iOS — server handles everything. Push notifications require the PWA to be installed to home screen.
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

## Feature Parity Status

| Feature | Extension | PWA | Notes |
|---------|-----------|-----|-------|
| Login/Auth | Cookie-based | ✅ Working | Server BFF + JWT, direct login + auto-relogin on 401 |
| Timetable | Full grid | ✅ Working | Filters, date carousel, status badges, IndexedDB 4hr TTL cache |
| Studio floor plan | Hover minimap | ✅ Working | Occupancy tooltip + booking modal with spot selection |
| Instructor tooltip | Photo + bio | ✅ Working | Hover tooltip (1s delay) — ⚠️ no touch support yet |
| Quick Book | Single slot | ✅ Working | One-click if prefs exist, else opens floor-plan modal |
| Auto-Book | 200ms interval | ✅ Working | Server-side precision scheduler + SSE live status stream |
| Auto-Upgrade | setInterval polling | ✅ Working | Server-side cron + 12h/1h cutoff + auto-register after booking |
| My Bookings | Table + cancel | ✅ Working | Penalty warning, double-click confirm, auto-upgrade toggle per row |
| Waitlists | Join/leave | ✅ Working | Join from timetable, leave from bookings, double-click confirm |
| Bookmarks | ♡/♥ toggle | ✅ Working | Native CodexFit bookmarks, "favourites only" filter |
| Buy Credits | Bundle table + cart | ✅ Working | Bundle cards, 8 filters, two-click cart → website checkout |
| Settings | All toggles | ✅ Working | 10 cards: booking, upgrade, push, notif prefs, export/import, debug, profile explorer, spot maps, delete data |
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
| Auto-Book Favourites | Syncs bookmarks → queue | ⚠️ Incomplete | UI saves favourite list to settings, but server doesn't auto-populate queue from it |
| .ics Calendar Download | From My Bookings | ❌ Missing | Extension had `downloadICS`; PWA does not |
| Native timetable augmentation | Injected buttons | N/A | Extension-only; PWA is standalone |

## Known Bugs / Issues

- **Auto-Book Favourites incomplete** — The Auto-Book tab has a "♥ Auto-Book Favourites" modal that saves `autoBookFavourites` (a list of bookmark identifiers) to user settings, but nothing in `scheduler.js` consumes this list to auto-create queue entries each week. The extension's `syncBookmarkedAutoBookings` logic has not been ported.
- **Mobile/iOS layout not full-screen** — The root panel uses `width: 1080px; max-height: 85vh; border-radius: 28px` (extension floating-panel heritage). On iOS installed to home screen, this doesn't feel native. Needs a mobile media query to make `.psycle-panel` full-viewport on small screens.
- **Hover tooltips don't work on touch** — Instructor + occupancy tooltips use `mouseover`/`mouseout` with delays. iOS users get nothing. Needs tap-to-toggle for touch devices.
- **Inline styles everywhere** — UI modules build elements with large `style="..."` strings instead of CSS classes, making maintenance and responsive tweaks painful (can't media-query inline styles). Should be migrated to `styles.css` / `panel-layout.css` classes over time.
- **No first-run onboarding** — New users log in to the timetable with no spot maps; every Quick-Book opens the modal. No "set your preferred spots" prompt.
- **No "Add to Home Screen" prompt** — iOS push requires install. The push settings card mentions it reactively, but there's no proactive install banner on first visit.

## Server API Routes

```
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

# Backup & Migration
GET    /api/config/export           # Export all preferences as JSON
POST   /api/config/import           # Import preferences from JSON (deduplicates auto-book)

# Cart
POST   /api/cart/create             # Create CodexFit cart instance, store cartInstanceId in settings
POST   /api/cart/add-bundle/:id     # Add bundle to cart (recreates cart on 404/410)
GET    /api/cart                    # Get current cart

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

## SQLite Schema (8 tables)

| Table | Purpose | Key columns |
|-------|---------|-------------|
| `users` | Accounts + encrypted creds | `email`, `encrypted_password`, `jwt`, `jwt_expires_at` |
| `auto_bookings` | Auto-book queue + history | `event_id`, `preferences` (JSON), `status`, `executed_at`, `studio_id`, `group_name` |
| `auto_upgrades` | Auto-upgrade monitors | `event_id`, `booking_id`, `current_slot_id`, `preferences` (JSON), `status`, `upgraded_slot_id` |
| `studio_preferences` | Shared spot maps | `studio_id`, `preferences` (JSON: `{preferredSlots[], preferredRows[]}`), `UNIQUE(user_id, studio_id)` |
| `settings` | Per-user settings | `preferences` (JSON blob — all settings + notification prefs + cartInstanceId) |
| `push_subscriptions` | Web Push endpoints | `subscription` (JSON string) |
| `booking_cache` | Reminder cache (client-synced) | `booking_id`, `event_id`, `start_at`, `slot_label`, `UNIQUE(user_id, booking_id)` |
| `sent_notifications` | Notification dedupe | `dedupe_key`, `UNIQUE(user_id, dedupe_key)` |
| `server_kv` | Key-value store | `jwt_secret`, `server_encryption_key`, `vapid_public_key`, `vapid_private_key` |

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
| `psycleDefaultFilters` | `localStorage` | Saved timetable filter selections (locations, instructors, eventTypes, bookmarks) |
| `psycleCacheEvents` / `psycleCacheMeta` | IndexedDB | Cached timetable events + metadata |
| `psycleCacheTime` | `localStorage` | Cache timestamp for TTL check |
| `psycleActiveStudioIds` / `psycleActiveStudioIdsTime` | `localStorage` | Active studio IDs for Spot Maps manager (24h TTL) |

## Environment Variables

| Variable | Used by | Purpose |
|----------|---------|---------|
| `PORT` | `server.js` | HTTP server port (default 3000) |
| `NODE_ENV` | `server.js` | If `production`, serves SPA static files |
| `DB_PATH` | `db.js` | SQLite database file path |
| `JWT_SECRET` | `auth.js` | Secret for signing local PWA JWTs (auto-generated + DB-stored fallback) |
| `ENCRYPTION_KEY` | `crypto.js` | Master key for AES-256-GCM password encryption (auto-generated + DB-stored fallback) |
| `VAPID_PUBLIC_KEY` | `push.js` | VAPID public key for Web Push (auto-generated + DB-stored fallback) |
| `VAPID_PRIVATE_KEY` | `push.js` | VAPID private key for Web Push (auto-generated + DB-stored fallback) |
| `VAPID_EMAIL` | `push.js` | `mailto:` VAPID contact (default: `mailto:admin@psycle.wingfield.tech`) |
