# Psycle App — Server + PWA Migration

> **Goal**: Migrate the Psycle Chrome Extension's core scheduling and booking features to a server-backed Progressive Web App so that auto-book, auto-upgrade, and other background features work reliably without requiring an open browser tab. The PWA will run on iOS via "Add to Home Screen" and receive push notifications.

> **Status**: ✅ Implemented and deployed. All core features working — auto-book (server-side precision scheduler), auto-upgrade (cron polling), quick-book, timetable, bookings, buy credits, push notifications (5 types), shared spot maps, Profile Explorer, notification preferences. See `AGENTS.md` for the current feature parity table and known issues. The sections below document the original architecture proposal; §4.5 and §4.7 have been updated to reflect what was actually built.

---

## 1. Reference: Chrome Extension Project

The existing Chrome Extension ([psycle-chrome repo](https://github.com/piersjones/psycle-chrome)) is the source of all business logic, API knowledge, and UI patterns. This section documents its complete architecture and feature set.

### 1.1 File Structure

```
browser_extension/
├── manifest.json      # V3 manifest (no service worker — all content-script driven)
├── content.js         # Main logic (~10,087 lines) — runs in ISOLATED world
├── interceptor.js     # Network interceptor + Vue bridge — runs in MAIN world
├── styles.css         # Liquid glass UI styles (~3,228 lines)
├── prefix-css.js       # CSS prefixing utility
└── icon*.png           # Extension icons
```

### 1.2 Architecture

The extension uses a **two-world content script architecture**:

| Script | World | Role |
|--------|-------|------|
| `interceptor.js` | MAIN | Intercepts `fetch`/`XMLHttpRequest`, sniffs cart instance IDs, reads Vue component data via `window.codex`, communicates via `postMessage` |
| `content.js` | ISOLATED | All extension UI, scheduling logic, API calls, `chrome.storage.local` access |

**No service worker or background script exists.** All scheduling (auto-book, auto-upgrade) runs via `setInterval` in the content script, which means the browser tab must remain open.

### 1.3 Feature Inventory

#### Buy Credits Tab
- Bundle search with sortable/filterable table (studios, classes, returning, expiry, cost/credit)
- Favorites pinning system with glassmorphic card UI
- MD5 gatekeeper password protection ("capetown")
- Cart integration with instance ID sniffing
- Selective cache clearing on purchase

#### Class Timetable Tab
- Horizontal date carousel for daily navigation
- Dynamic multiselect dropdown filters: Location, Instructor, Class Type (Workout Type)
- Accurate class status: `is_fully_booked` for waitlist vs available
- Live booking cutoff logic (Monday 12:00 PM rolling release + settings modifiers)
- Grayed-out rows with "Auto book" for classes beyond cutoff
- Credit eligibility alerts
- Hoverable studio floor plan minimaps with red/green status glows
- Class occupancy spot count ("Available (x)")
- Debug button (togglable in Settings)

#### Booking & Waitlist Flows
- Slot selection modal with interactive floor plan
- Multi-slot booking with parallel fetch dispatches
- Waitlist join via `PUT /waitlists/{id}`
- Unmapped available spot grid rendering

#### My Bookings Tab
- Active Bookings and Active Waitlists tables
- Grouped multi-slot bookings with separate cancel actions
- Cancel with red warning banner and "(Penalty)" label if <12 hours before start
- Leave waitlist penalty-free
- "Upgrade" button per booking row (links to auto-upgrade)

#### Auto-Book Tab
- Precision countdown scheduler (200ms interval) targeting Monday 12:00 PM London time
- T-30s prefetch of slot availability
- T-0 booking dispatch with 1-second stagger between classes
- Slot priority tiers: individually chosen > row chosen > fallback (`bookAny`)
- Waitlist fallback on total booking failure
- History section with 24h retention
- Studio-specific default preference templates
- Full preferences Export/Import JSON

#### Auto-Upgrade
- Configurable polling intervals (1min / 15min / 1hr)
- Monitors booked classes for preferred slot availability
- Books upgraded slot, verifies booking, then cancels original
- Stops monitoring at 12h before class start (or books-but-keeps-original if `keepOriginalOnCutoff`)
- Pauses if no credits available (`paused_no_credits`)
- Status tracking: active / upgraded / stopped / paused_no_credits / cutoff_booked
- Post-booking toast suggesting auto-upgrade setup

#### Settings Pane
- Advanced Booking Privileges (+1 week)
- Advanced Booking Credits (+1 week)
- Timetable prefetch range (weeks)
- Debug Mode toggle
- Native timetable augmentation toggles (Quick-Book, New-Tab Booking, Smart Caching)
- Auto-upgrade global toggle and polling interval
- Studio preference editor for slot maps
- Export/Import preferences JSON

#### Native Timetable Augmentation (Phase 6)
- Quick-Book / Auto-Book / Waitlist buttons injected into native timetable event cards via `MutationObserver`
- New-Tab Booking: intercepts `codex-event-modal` event, opens class page in new tab
- Smart Caching: 4hr TTL with Monday 12PM force-refresh
- Vue data bridge via `postMessage` protocol between `interceptor.js` (MAIN world) and `content.js` (ISOLATED world)

### 1.4 Scheduling Mechanisms

| Feature | Trigger | Precision | Persistence | Fails When |
|---------|---------|-----------|-------------|------------|
| Auto-Book | Monday 12:00 PM release window | 200ms interval, T-30s prefetch | `psycleAutoBookings` in `chrome.storage.local` | Tab closed or navigated away |
| Auto-Upgrade | Polling interval (1min/15min/1hr) | Configurable interval | `psycleAutoUpgrades` in `chrome.storage.local` | Tab closed or navigated away |

### 1.5 Storage Keys

| Key | Purpose |
|-----|---------|
| `psycleSettings` | User preferences (advanced booking, debug mode, etc.) |
| `psycleAutoBookings` | Auto-book queue and execution history |
| `psycleAutoUpgrades` | Auto-upgrade monitoring state |
| `psycleStudioPreferences` | Per-studio slot preference maps |
| `psycleCacheData` / `psycleCacheTime` | Timetable cache (8hr TTL) |
| `psycleCacheMetadata` / `psycleCacheMetadataTime` | Metadata cache |
| `psycleMetadata` | Resolved API relations (instructors, studios, etc.) |
| `psycleFavorites` | Bundle favorites |
| `codex-cart` | Cart instance ID (sniffed from page) |
| `codex-store` | CodexFit Vue app state |
| `psycleUnlocked` | MD5 gatekeeper unlock state |

---

## 2. CodexFit API Reference

Base domain: `https://psycle.codexfit.com/api/v1/customer`

### 2.1 Authentication Endpoints (NEW — discovered via browser investigation)

#### Direct Login
```
POST /api/v1/customer/auth/login
Content-Type: application/json
Origin: https://psyclelondon.com

Body: { "email": "user@example.com", "password": "password123" }

Success (200): { "access_token": "<JWT>", "user": { ... } }
Failure (500): { "message": "Invalid login credentials", "exception": "App\\Exceptions\\PublicLoginException" }
Validation (422): { "message": "The email field is required.", "errors": { "email": ["The email field is required."], "password": ["The password field is required."] } }
```

#### Shopify Multipass Login
```
POST /api/v1/customer/auth/multipass/login
Content-Type: application/json
Origin: https://psyclelondon.com

Body: { "multipass_token": "<signed_token>" }

Success (200): { "access_token": "<JWT>", "user": { ... } }
Failure (400): { "success": false, "error": "Token signing is invalid" }
```

**How multipass works on the website**: When a user logs in via Shopify's auth system, Shopify generates a signed multipass token. The CodexFit Vue app reads this from `window.codex.multipassToken` or the `?multipass=TOKEN` URL parameter, then calls the multipass login endpoint to exchange it for a JWT. The JWT is stored as a cookie (`codex_bearer_token`) with a 365-day expiry.

#### Token Validation
```
GET /api/v1/customer/auth/user
Authorization: Bearer <JWT>

Success (200): User profile object
Failure (401): { "message": "Unauthenticated." }
```

#### Logout
```
GET /api/v1/customer/auth/logout
(Invalidates the current JWT)

Success (200): { "success": true, "message": "Successfully logged out" }
```

#### Registration
```
POST /api/v1/customer/auth/register
Content-Type: application/json

Body: { ... } (requires reCaptcha validation)
Failure (500): { "message": "Invalid reCaptcha. Try reloading and retrying." }
```

#### Token Refresh
**Does not exist.** There is no `/auth/refresh`, `/auth/token/refresh`, or similar endpoint. When the JWT expires, the user must re-authenticate via `/auth/login` or `/auth/multipass/login`.

### 2.2 Public Endpoints (No Auth Required)

| Endpoint | Method | Key Params | Returns |
|----------|--------|------------|---------|
| `/events` | GET | `location`, `start`, `end` | Events array + relations |
| `/events/{id}` | GET | — | Single event + slots + booking info |
| `/locations` | GET | — | Location list |
| `/studios` | GET | — | Studio list (with layouts) |
| `/instructors` | GET | — | Instructor list |
| `/event-types` | GET | — | Class type list |
| `/event-type-groups` | GET | — | Workout group categories |
| `/bundles` | GET | — | Purchasable credit bundles (including hidden) |
| `/heartbeat` | GET | — | Health check + cache timestamps + `logged-in` flag |

### 2.3 Authenticated Endpoints (Bearer JWT Required)

| Endpoint | Method | Key Params | Returns |
|----------|--------|------------|---------|
| `/profile` | GET | — | User profile, `booking_cutoff`, `extended_cutoff` |
| `/credits` | GET | `type=unused`, `per_page=999` | User's unused credits |
| `/bookings` | GET | `limit=100`, `page=1` | Active bookings |
| `/waitlists` | GET | `page=1` | Active waitlists |
| `/subscriptions` | GET | — | Recurring plans/memberships |
| `/bookings` | POST | `{ event_id, slots: [id] }` | Create a booking |
| `/bookings/{id}` | DELETE | — | Cancel a booking |
| `/waitlists/{id}` | PUT | — | Join a waitlist |
| `/waitlists/{id}` | DELETE | — | Leave a waitlist |

### 2.4 Bookmark Endpoints (Auth Required)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/profile/metafields/bookmarks.events.{identifier}` | PUT | Add bookmark (`{ "data": "1380000100001930" }`) |
| `/profile/metafields/bookmarks.events.{identifier}` | DELETE | Remove bookmark |
| `/profile/metafields/bookmarks.events` | DELETE | Clear all bookmarks |

**Bookmark identifier formula**: `studioId + "0000" + dayOfWeek + "0000" + HHmm`
Example: Studio 138, Monday, 19:30 → `"1380000100001930"`

### 2.5 Required Headers

```http
accept: application/json
origin: https://psyclelondon.com
referer: https://psyclelondon.com/
x-organisation: [object Object]
```

For authenticated requests, add:
```http
authorization: Bearer <JWT_TOKEN>
```

### 2.6 Key Data Structures

#### Events Response
```json
{
  "data": [
    {
      "id": 205278,
      "event_type_id": 3709,
      "instructor_id": 477,
      "studio_id": 104,
      "start_at": "2026-06-14T09:00:00",
      "duration": 45,
      "bookable_until": "2026-06-14T09:45:00",
      "required_credits": 1,
      "credit_types": [{"credit_type": 1}],
      "is_visible": true,
      "is_waitlistable": true,
      "is_always_bookable": false,
      "is_fully_booked": false,
      "status": "upcoming",
      "occupancy": 31,
      "capacity": 35,
      "max_bookable_slots": 4
    }
  ],
  "relations": {
    "studios": [...],
    "locations": [...],
    "event_types": [...],
    "instructors": [...]
  }
}
```

#### Event Detail Response (includes slots)
```json
{
  "data": {
    "id": 205278,
    "slots": [
      { "id": 17, "name": "Bike 17", "status": "available", "row": 2, "column": 3 }
    ],
    "bookings": [...],
    "valid_credits": [...],
    "valid_subscriptions": [...],
    "is_bookable_standard": true,
    "is_bookable_extended": false
  }
}
```

#### User Profile Response
```json
{
  "data": {
    "id": 12345,
    "first_name": "John",
    "last_name": "Doe",
    "email": "john@example.com",
    "booking_cutoff": "2026-06-22T23:59:59",
    "extended_cutoff": "2026-06-29T23:59:59",
    "metafields": {
      "extended_booking_allowed": false
    }
  }
}
```

---

## 3. Website Functionality Research

### 3.1 Architecture

The Psycle London website (`psyclelondon.com`) is a **Shopify-hosted storefront** that embeds a **CodexFit Vue.js application** for all booking functionality. The Vue app mounts into `<div id="codex-main-app">` and renders the timetable, booking modals, and user account features client-side.

**Key scripts**:
- `app.js` from `api-v2.codexfit.com/latest/app.js` — CodexFit Vue app (minified)
- `addons.js` from `api-v2.codexfit.com/clients/psycle/addons.js` — Psycle customizations (includes axios)

**Vue component hierarchy**:
```
codex-main-app (root)
├── timetable (manages events, filters, carousel)
│   ├── timetable-filter × 2 (instructor, event_type_group)
│   ├── VueSlickCarousel (date navigation)
│   └── VueSlickCarousel (events carousel per day)
│       └── [event-container divs] (per class)
└── event (booking modal / class detail)
```

### 3.2 Authentication Flow (Website)

The website uses **Shopify's SSO system** for authentication:

1. User clicks "Login" → redirected to Shopify's auth page (`shopify.com/authentication/...`)
2. User authenticates with email/password via Shopify
3. Shopify generates a **multipass token** (signed, time-limited)
4. User is redirected back to `psyclelondon.com?multipass=<TOKEN>`
5. The CodexFit Vue app's `initialiseStore` mutation detects the multipass token:
   ```javascript
   if (!mt.get("codex_bearer_token")) {
     // Check window.codex.multipassToken or URL param ?multipass=
     if (window.codex.multipassToken) {
       this.dispatch("multipassLogin");
     }
   }
   ```
6. `multipassLogin` action calls `POST /api/v1/customer/auth/multipass/login` with the token
7. Response: `{ access_token: "<JWT>", user: { ... } }`
8. JWT is stored as cookie `codex_bearer_token` with 365-day expiry via `mt.set("codex_bearer_token", access_token, 365)`
9. All subsequent API calls use `Authorization: Bearer <JWT>` header

**Critical finding**: The CodexFit API also supports **direct email/password login** via `POST /api/v1/customer/auth/login` — this is not used by the website but is fully functional. This is the key enabler for the server + PWA architecture.

### 3.3 Booking Window Logic

The website uses a **rolling Monday 12:00 PM release system**:

| Window | Cutoff | Who Can Book |
|--------|--------|-------------|
| Standard | `customer.booking_cutoff` | All authenticated users |
| Extended | `customer.extended_cutoff` | Users with `metafields.extended_booking_allowed = true` |
| Always | N/A | Classes flagged `is_always_bookable` |

The `isBookable(event)` Vue method checks:
1. If not logged in → only show future events
2. If past `bookable_until` → not bookable
3. If past `start_at` → not bookable
4. If `is_always_bookable` → always bookable
5. If before `booking_cutoff` → bookable
6. If before `extended_cutoff` → bookable with extended privileges

### 3.4 Location ID Mapping

| URL Path | Location ID | Location Name |
|----------|------------|---------------|
| `/pages/oxford-circus-timetable` | 1 | Oxford Circus |
| `/pages/shoreditch-timetable` | 2 | Shoreditch |
| `/pages/clapham-timetable` | 3 | Clapham |
| `/pages/notting-hill-timetable` | 4 | Notting Hill |
| `/pages/victoria-timetable` | 5 | Victoria |
| `/pages/bank-timetable` | 6 | Bank |
| `/pages/london-bridge-timetable` | 7 | London Bridge |

### 3.5 Custom Events

| Event Name | Detail | Source | Purpose |
|-----------|--------|--------|---------|
| `codex-event-modal` | `event.id` (number) | Timetable `gotoEvent()` | Opens booking modal |
| `codex-login-toggle` | — | Event component | Opens login dialog |

---

## 4. Server + PWA Architecture Proposal

### 4.1 Problem Statement

The Chrome Extension requires an **open browser tab** on `psyclelondon.com` for:
- Auto-book precision scheduling (200ms interval at Monday 12:00 PM)
- Auto-upgrade polling (1min/15min/1hr intervals)
- JWT token access (read from `document.cookie`)
- API calls (made from content script context)

If the tab is closed, navigated away, or the browser is quit, all scheduling stops. This is fundamentally unreliable for time-critical booking operations.

Additionally, the extension is **desktop-only** — iOS users (the primary audience) cannot use it at all.

### 4.2 Solution: Server + PWA

```
┌─────────────────────────────────────────────────────────────┐
│  PWA (installed to iOS/Android/desktop home screen)          │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │  Login: email + password                                │ │
│  │  → POST /api/v1/customer/auth/login → JWT               │ │
│  │  → JWT stored locally + sent to server (encrypted)     │ │
│  │                                                         │ │
│  │  Tabs (reused from extension UI):                       │ │
│  │  • Buy Credits — bundle search, favorites, cart         │ │
│  │  • Class Timetable — filters, date carousel, booking    │ │
│  │  • My Bookings — active bookings, waitlists, cancel     │ │
│  │  • Auto-Book — schedule, countdown, history             │ │
│  │  • Auto-Upgrade — monitor, upgrade, preferences         │ │
│  │  • Settings — preferences, export/import               │ │
│  │                                                         │ │
│  │  Push Notifications:                                   │ │
│  │  • Booking confirmed / failed                           │ │
│  │  • Waitlist joined / left                              │ │
│  │  • Auto-book executed                                  │ │
│  │  • Auto-upgrade completed                              │ │
│  │  • Token expiring soon — please re-login               │ │
│  └─────────────────────────────────────────────────────────┘ │
│                          │ HTTPS                            │
└──────────────────────────┼──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│  Server (Node.js on Railway/Render ~$5/mo)                  │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │  Auth Service                                           │ │
│  │  • POST /auth/login → proxy to CodexFit, store JWT     │ │
│  │  • POST /auth/register → proxy to CodexFit             │ │
│  │  • GET /auth/status → check if JWT is still valid      │ │
│  │  • POST /auth/refresh → re-login with stored creds     │ │
│  │  • Encrypted credential storage (AES-256)              │ │
│  │                                                         │ │
│  │  API Proxy                                              │ │
│  │  • All /api/v1/customer/* endpoints proxied            │ │
│  │  • Injects Bearer token from stored JWT                │ │
│  │  • CORS headers for PWA origin                         │ │
│  │                                                         │ │
│  │  Auto-Book Scheduler                                    │ │
│  │  • Precision setTimeout for Monday 12:00 PM London      │ │
│  │  • T-30s slot availability prefetch                    │ │
│  │  • T-0 booking dispatch with stagger                    │ │
│  │  • Waitlist fallback on failure                         │ │
│  │  • Web Push notification on result                     │ │
│  │                                                         │ │
│  │  Auto-Upgrade Poller                                    │ │
│  │  • Configurable intervals (1min/15min/1hr)             │ │
│  │  • Slot availability checks                            │ │
│  │  • Book preferred → verify → cancel original           │ │
│  │  • 12h cutoff logic with keepOriginalOnCutoff          │ │
│  │  • Pause on no credits                                  │ │
│  │  • Web Push notification on upgrade                    │ │
│  │                                                         │ │
│  │  Notification Service                                   │ │
│  │  • Web Push (VAPID) for iOS 16.4+ and Android          │ │
│  │  • Email fallback (optional)                            │ │
│  │                                                         │ │
│  │  Database (SQLite / PostgreSQL)                         │ │
│  │  • Users: id, email, encrypted_password, jwt, jwt_exp  │ │
│  │  • Auto-book queue: event_id, preferences, status      │ │
│  │  • Auto-upgrades: booking_id, preferences, status      │ │
│  │  • Studio preferences: slot maps per studio              │ │
│  │  • Notification subscriptions: push endpoints            │ │
│  │  • Settings: per-user preferences                      │ │
│ └─────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

### 4.3 Authentication Strategy

**Primary: Direct Login (server-side)**

The discovery that `POST /api/v1/customer/auth/login` accepts `{ email, password }` and returns `{ access_token, user }` is the key enabler. The server can:

1. User enters Psycle credentials in the PWA
2. Server proxies the login request to CodexFit
3. Server stores the JWT (encrypted at rest) and credentials (AES-256 encrypted)
4. Server uses the JWT for all subsequent API calls
5. When JWT expires (detected via 401 responses), server re-authenticates with stored credentials
6. If re-authentication fails, server sends push notification: "Please re-login"

**Fallback: WebView Token Capture**

If CodexFit ever removes the direct login endpoint or adds additional verification (e.g., reCaptcha), the PWA can fall back to:
1. Open a WebView/Safari view pointing to `psyclelondon.com/account/login`
2. User logs in via the normal Shopify flow
3. Intercept the `codex_bearer_token` cookie from the WebView
4. Send the JWT to the server

This is less elegant but guarantees the auth flow always works.

**Token Lifecycle**:

```
┌──────────┐     ┌──────────┐     ┌──────────────┐
│  PWA     │────▶│  Server  │────▶│  CodexFit    │
│  Login   │     │  Auth    │     │  API         │
└──────────┘     └──────────┘     └──────────────┘
     │                │                    │
     │  email/pass    │  POST /auth/login  │
     │                │───────────────────▶│
     │                │  { access_token }  │
     │                │◀───────────────────│
     │                │                    │
     │                │  Store encrypted   │
     │                │  JWT + credentials │
     │                │                    │
     │  JWT + user    │                    │
     │◀───────────────│                    │
     │                │                    │
     │                │  API calls with    │
     │                │  Bearer token      │
     │                │───────────────────▶│
     │                │                    │
     │                │  401 Unauthorized  │
     │                │◀───────────────────│
     │                │                    │
     │                │  Re-login with     │
     │                │  stored creds      │
     │                │───────────────────▶│
     │                │  New JWT            │
     │                │◀───────────────────│
     │                │                    │
     │  Push: "Token  │                    │
     │  refreshed"    │                    │
     │◀───────────────│                    │
     │                │                    │
     │                │  Re-login fails    │
     │                │───────────────────▶│
     │                │  500 Invalid creds │
     │                │◀───────────────────│
     │                │                    │
     │  Push: "Please │                    │
     │  re-login"      │                    │
     │◀───────────────│                    │
```

### 4.4 PWA Architecture

**Tech Stack**:
- **Frontend**: Vanilla HTML/CSS/JS (direct port of extension UI) or lightweight framework (Preact/Vue)
- **Service Worker**: Offline caching, push notification handling
- **Web App Manifest**: Home screen install, splash screen, theme color
- **Backend API**: Node.js + Express (or Fastify) on Railway/Render

**PWA Manifest**:
```json
{
  "name": "Psycle",
  "short_name": "Psycle",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#1a1a2e",
  "theme_color": "#7c3aed",
  "icons": [
    { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png" }
  ]
}
```

**iOS Web Push Support**:
- iOS 16.4+ supports Web Push for PWAs installed to the home screen
- Requires VAPID key pair for push subscription
- Push notifications work even when the PWA is not in the foreground
- Limitation: No background sync on iOS (but server handles all background work)

**UI Migration**:
The extension's existing HTML/CSS/JS can be directly ported to the PWA. The Liquid Glass theme, tab navigation, modals, and all interactive components are self-contained and don't depend on Chrome extension APIs. Key changes:
- Replace `chrome.storage.local` with `localStorage` or server-side storage
- Replace `document.cookie` token reading with server-provided auth
- Add service worker for offline caching and push notifications
- Add login screen (email + password)
- Add "Add to Home Screen" prompt

### 4.5 Server Architecture

**Tech Stack**:
- **Runtime**: Node.js 20+
- **Framework**: Fastify (or Express)
- **Database**: SQLite (via better-sqlite3) for single-server, PostgreSQL for managed hosting
- **Encryption**: AES-256-GCM for credential storage
- **Push**: web-push library (VAPID)
- **Scheduling**: node-cron for periodic tasks, precision `setTimeout` for auto-book
- **Hosting**: Railway, Render, or Fly.io (~$5/mo)

**API Routes** (implemented):

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

**Auto-Book Scheduler**:
```javascript
// Server-side precision scheduler
class AutoBookScheduler {
  async scheduleForMonday() {
    const nextMonday = getNextMondayNoonLondon();
    const delay = nextMonday - Date.now();
    
    // Prefetch at T-30s
    setTimeout(() => this.prefetchSlots(), delay - 30000);
    
    // Execute at T-0
    setTimeout(() => this.executeBookings(), delay);
  }
  
  async executeBookings() {
    const queue = await db.getPendingAutoBooks();
    for (const item of queue) {
      await this.bookWithRetry(item);
      await this.notifyUser(item.userId, 'auto-book-result', item);
      await sleep(1500); // 1.5s stagger
    }
  }
}
```

**Auto-Upgrade Poller**:
```javascript
// Server-side polling engine
class AutoUpgradePoller {
  start() {
    // Check all active upgrades at their configured intervals
    cron.schedule('* * * * *', () => this.checkUpgrades('1min'));
    cron.schedule('*/15 * * * *', () => this.checkUpgrades('15min'));
    cron.schedule('0 * * * *', () => this.checkUpgrades('1hr'));
  }
  
  async checkUpgrades(interval) {
    const upgrades = await db.getActiveUpgrades(interval);
    for (const upgrade of upgrades) {
      await this.attemptUpgrade(upgrade);
    }
  }
}
```

### 4.6 Security Considerations

1. **Credential Storage**: User passwords are encrypted with AES-256-GCM using a server-side key. The key is stored in environment variables, never in the database.
2. **JWT Storage**: JWTs are stored encrypted in the database. They're only decrypted when making API calls.
3. **HTTPS Only**: All communication between PWA and server is over HTTPS.
4. **No Client-Side Secrets**: The PWA never stores credentials locally. The JWT is stored in memory/localStorage and sent to the server for encrypted storage.
5. **Rate Limiting**: Server-side rate limiting on all API endpoints to prevent abuse.
6. **CORS**: Strict CORS policy allowing only the PWA origin.
7. **Input Validation**: All user inputs validated server-side before proxying to CodexFit.

### 4.7 Migration Path

> **All phases complete.** The server + PWA is functional and deployed.

**Phase 1: Server Foundation ✅**
- Node.js + Express server with auth endpoints (login, status, delete)
- API proxy for all CodexFit endpoints with auto-relogin on 401
- SQLite database with 8-table schema (users, auto_bookings, auto_upgrades, studio_preferences, settings, push_subscriptions, booking_cache, sent_notifications, server_kv)
- AES-256-GCM credential encryption
- Deployed to Raspberry Pi via Docker

**Phase 2: PWA Shell ✅**
- Vite PWA with service worker (push + offline cache) and manifest
- Login screen (email + password → server BFF)
- 6-tab SPA: Class Timetable, My Bookings, Auto-Book, Buy Credits, Settings, About
- IndexedDB 4hr TTL caching with Monday 12PM force-refresh

**Phase 3: Auto-Book Server-Side ✅**
- Precision scheduler: setTimeout → T-5s → 10ms setInterval polling Date.now()
- T-30s slot prefetch, T-0 parallel dispatch with 500ms per-slot cooldown
- SSE live status stream (Planning → Attempting → Success/Failed)
- Push notifications for booking results
- Shared studio spot map (one map per studio, live-resolved at execution)

**Phase 4: Auto-Upgrade Server-Side ✅**
- node-cron polling engine (every minute, respects per-monitor interval)
- 12h cutoff with keepOriginalOnCutoff option, 1h hard stop
- Auto-register after booking if `autoUpgradeByDefault` setting is on
- Cancellation reminders (24h/14h) + booking window reminders (Mon 11AM)

**Phase 5: Polish & Launch ✅**
- iOS Safari PWA testing
- Push notification testing on iOS 16.4+
- Export/Import preferences from extension (compatible format)
- Profile Explorer with Konami-code edit mode
- Notification preferences modal (per-type toggles + scope/timing)
- Debug mode: per-class diagnostics, debug log terminal, simulate release

**Remaining work** (not in original plan):
- Auto-Book Favourites weekly auto-sync (UI exists, server doesn't consume the list)
- Mobile/iOS full-screen layout (still uses floating-panel heritage dimensions)
- Touch support for hover tooltips
- `.ics` calendar download from My Bookings
- First-run onboarding for spot maps
- Proactive "Add to Home Screen" prompt

### 4.8 Extension Coexistence

The Chrome Extension and PWA can coexist:
- **Shared data**: Settings, preferences, and auto-book queues can be synced via the server
- **Token relay**: Extension can optionally push JWT to server for server-side use
- **Gradual migration**: Users can start with the extension and migrate to PWA at their own pace
- **Export/Import**: Extension's existing export/import JSON format can be supported by the PWA for seamless migration

### 4.9 Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| CodexFit removes direct login endpoint | Low | High | Fallback to WebView token capture; monitor API changes |
| CodexFit adds reCaptcha to login | Medium | Medium | Implement reCaptcha solving or WebView fallback |
| JWT expires and re-login fails | Low | Medium | Push notification to user; retry with exponential backoff |
| iOS Web Push limitations | Low | Low | Server handles all background work; push is for notifications only |
| CodexFit rate limiting | Medium | Medium | Implement request throttling; cache aggressively |
| Server downtime during booking window | Low | High | Use managed hosting with 99.9% uptime; implement health checks |
| Credential breach | Low | Critical | AES-256 encryption; environment variable keys; no plaintext storage |

### 4.10 Cost Estimate

| Component | Monthly Cost | Notes |
|-----------|-------------|-------|
| Railway/Render server | $5 | 1GB RAM, 1 vCPU |
| Domain (optional) | $1 | e.g., psycle.app |
| Total | ~$5-6/mo | Scales to ~1000 users on basic plan |

No App Store fees. No Apple Developer account. No Google Play account. The PWA is distributed via URL — users "Add to Home Screen" from Safari/Chrome.

---

## 5. Key Differences: Extension vs PWA (as implemented)

| Aspect | Chrome Extension | Server + PWA |
|--------|-----------------|---------------|
| **Auth** | Reads `codex_bearer_token` cookie from browser | Direct login via `POST /auth/login`; server stores encrypted creds + JWT |
| **Auto-Book** | 200ms `setInterval` in content script | Server-side `setTimeout` → T-5s → 10ms `setInterval` polling `Date.now()` |
| **Auto-Upgrade** | `setInterval` polling in content script | Server-side `node-cron` every minute, per-monitor interval gating |
| **Background Operation** | Requires open browser tab | Runs 24/7 on server |
| **iOS Support** | None | Full support via PWA (iOS 16.4+) |
| **Push Notifications** | None | Web Push (VAPID), 5 types, per-user prefs, deduped |
| **Token Refresh** | None (user must re-login on website) | Automatic re-authentication with stored credentials on 401 |
| **Data Storage** | `chrome.storage.local` | Server SQLite (8 tables) + `localStorage` + IndexedDB |
| **Spot Preferences** | Per-entry preferences stored separately | One shared spot map per studio, live-resolved by all features |
| **UI Framework** | Vanilla HTML/CSS/JS injected into page | Same aesthetic, served as standalone Vite PWA |
| **Distribution** | Chrome Web Store | URL — "Add to Home Screen" |
| **Cost** | Free (Chrome Web Store) | ~$5/mo self-hosted (Raspberry Pi) |
| **Offline Support** | None | Service worker network-first caching for shell assets |
| **Live Status** | None | SSE stream for real-time auto-book execution updates |
| **Reminders** | None | Cancellation reminders (24h/14h) + booking window reminder (Mon 11AM) |
| **Profile Editing** | Raw JSON inspector | Categorized Profile Explorer + Konami-code edit mode |