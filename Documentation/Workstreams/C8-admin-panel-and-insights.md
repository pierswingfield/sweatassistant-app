# C8 — Admin Panel, Fleet Intelligence, Data Foundation and Ops

**Priority:** P2 · **Size:** ~2 weeks across 7 phased increments  
**Depends on:** C4 (modular multi-gym baseline in production), F-7 (dynamic presentation contract & registry discovery)  
**Blocks:** Scaled multi-gym operations (3+ gyms), F-10 (Home Dashboard), F-11 (Class Stats & Insights)

> **Verify first:** before changing anything for an item, confirm its basis in the code **and**, for anything user-visible, **in a real browser** (CDP :9222 or Claude for Chrome). For server-only items, use a failing test or a request. Record the evidence. If a browser check is needed and no browser is available, stop with `BLOCKED`. See [AGENT_PROTOCOL.md](AGENT_PROTOCOL.md).

---

## Architectural Mandate: True Gym-Agnostic Multi-Tenancy

Every feature, chart, table, filter, background process, and batch action in the admin panel must adhere strictly to the modular gym architecture:

1. **Zero Hardcoded Gym IDs**: Never test `gymId === 'psycle-london'` or `id.includes('jab')` in admin routes, queries, background workers, or UI templates.
2. **Dynamic Gym Discovery**: All gym lists, filter selectors, color badges, and tabs are dynamically populated from `db.getGyms()` and `gymsConfig.listGyms()`. Adding a 3rd or 10th gym to `gyms.config.js` (or via the F-7 presentation editor) must immediately incorporate that gym across all admin views without code changes.
3. **Normalized Data Boundaries**: All attendance, schedule, booking, and profile records pass through the normalized provider schema (`booking_cache`, `calendar_classes`, `makeEvent`, `makeSlot`). UI cards consume generic fields (`startAt`, `className`, `discipline`, `instructorName`, `studioName`, `locationName`, `slotLabel`, `gymId`).
4. **Capability-Gated Controls**: Features not supported by a gym's platform adapter (e.g. `spotSelection`, `waitlists`, `creditPurchase`) are dynamically hidden or disabled based on `gymConfig.capabilities`, not gym name.
5. **Presentation Contract Integration**: Gym chips, logos, badge colors, and display aliases are rendered directly from the F-7 presentation contract (`presentation.assets.mark`, `presentation.palette`, `presentation.shortName`, `presentation.displayAliases`).

---

## Workstream Items

| # | Item | Focus | Est. |
|---|---|---|---|
| **C8-1** | **Foundational Data Pipeline: Event Ledger, Booking Lifecycle & Profile Harvester** | Immutable `system_events` audit trail, durable `booking_ledger` state machine (retaining full history across purges), and background gym profile scraper/ETL for rich account data. | 3–4 days |
| **C8-2** | **Feature Usage Analytics Engine (Integrated Library & Admin Dashboard)** | Self-contained, privacy-preserving embedded analytics engine in SQLite. Auto-wired client interaction tracker (tabs, clicks, modals), server route telemetry, and visual analytics tab in `/admin`. | 2–3 days |
| **C8-3** | **Filterable Live View of User Class Attendance & Schedule** | Cross-gym master attendance table, dynamic multi-select filters, collision/cohort view (multiple users in the same class), live studio spot mapping (`spotmap.js`). | 2–3 days |
| **C8-4** | **Cross-Gym User Usage & Individual Intelligence** | Cross-gym discipline split, workout habit heatmaps, expiring credit radar, auto-book/upgrade win rates, and relogin health. | 2 days |
| **C8-5** | **Per-Gym Fleet Analytics & Platform Health** | Gym ecosystem market share, booking demand heatmaps ("battleground classes"), provider API latency & 429 backoff monitor. | 2 days |
| **C8-6** | **Day-to-Day Operational Diagnostics & Release War Room** | Policy-driven release countdown & live SSE execution monitor, Web Push tester, on-demand token refresh/upgrade triggers, read-only impersonation preview. | 2 days |
| **C8-7** | **Batch Operations & Pre-Flight Fleet Sweeps** | Bulk priority tier adjustments, gym-targeted push & banner broadcasts, automated Sunday pre-release health sweep (tokens + credits). | 1–2 days |

---

## Detailed Specifications

### C8-1: Foundational Data Pipeline: Event Ledger, Booking Lifecycle & Profile Harvester

#### Why This Exists
Today, the server's data persistence is largely transient: `booking_cache` and `waitlist_cache` are continuously wiped and replaced by upstream syncs, execution logs live only as single message strings in `auto_bookings`, and gym profile data is cached as an ephemeral JSON blob. To power deep admin insights, historical analytics, and future user-facing features (F-10 Home Dashboard, F-11 Stats & Milestones, F-9 AI Assistant), the system requires durable foundational data capture.

#### Architecture & Data Contracts
1. **Immutable System Event Ledger (`system_events`)**:
   - A high-throughput, structured append-only event table in SQLite (WAL mode):
     - `id`, `timestamp`, `event_type`, `user_id`, `gym_id`, `level` (`info`, `warn`, `error`), `payload` (JSON).
   - **Captured Events**:
     - **Auth Lifecycle**: `auth.login`, `auth.relogin.success`, `auth.relogin.rejected`, `auth.session_expired`.
     - **Booking Lifecycle**: `booking.created`, `booking.cancelled`, `booking.spot_upgraded`, `booking.waitlist_joined`, `booking.waitlist_promoted`.
     - **Automation Execution**: `scheduler.wake`, `autobook.attempt`, `autobook.success`, `autobook.fallback_spot`, `autobook.failed`, `upgrade.checked`, `upgrade.executed`.
     - **Platform & Ops**: `push.dispatched`, `push.failed_expired_token`, `provider.rate_limit_429`, `provider.circuit_breaker`.

2. **Durable Booking Lifecycle Tracker (`booking_ledger`)**:
   - Unlike `booking_cache` (which only knows upcoming classes), `booking_ledger` preserves every class ever booked or imported:
     - `id`, `user_id`, `gym_id`, `booking_id`, `event_id`, `start_at`, `class_name`, `group_name`, `instructor_name`, `studio_name`, `location_name`, `slot_label`, `initial_slot_label`, `booked_by` (`quickbook`, `autobook`, `upgrade`, `external_import`), `status` (`confirmed`, `attended`, `cancelled`, `no_show`, `upgraded`), `credits_cost`, `created_at`, `updated_at`.
   - **State Machine Reconciliation**:
     - Background sync compares provider responses against `booking_ledger`. If a booking is no longer returned after its `start_at` has passed, mark as `attended` (or check gym's explicit attendance API). If dropped before `start_at`, mark as `cancelled`.

3. **Background Gym Profile Harvester / Scraper (ETL Pipeline)**:
   - For every linked gym, systematically extract and persist rich profile metadata:
     - **Stats**: Total lifetime classes, attended minutes, first visit date, loyalty status.
     - **Credit Bundles**: Package name, remaining credits, purchase date, strict expiry date, price paid.
     - **Membership Subscriptions**: Active tier, renewal date, pause status, billing cycle, cutoff days.
   - **Harvest Triggers**:
     - On user login or gym re-link.
     - Event-driven: immediately after successful booking or cancellation.
     - Scheduled low-frequency sweep: daily off-peak run with rate-limiting backoff.
   - Persists normalized records in `user_gym_stats` and `user_credit_packages` tables for immediate indexed querying.

---

### C8-2: Feature Usage Analytics Engine (Integrated Library & Admin Dashboard)

#### Why This Exists
To make informed decisions about product development, we need precise, privacy-conscious data on how users interact with the PWA: Which tabs are most viewed? Do users use the studio floor plan or quick-book? How many users set up Auto-Upgrade? What is the funnel completion rate for onboarding?

#### Architecture & Integrated Telemetry
1. **Embedded Analytics Storage (Zero External SaaS)**:
   - Built directly into the application stack using SQLite (`analytics_events` and `analytics_daily_rollups`). No third-party tracking scripts (Google Analytics, Mixpanel, etc.) that can be blocked by ad blockers or leak fitness habits.
   - Schema: `id`, `session_id`, `user_id`, `timestamp`, `event_category`, `event_action`, `event_label`, `metadata_json`, `gym_id`, `viewport`, `is_pwa`.

2. **Client Auto-Wiring Tracker (`client/src/analytics.js`)**:
   - Automatically wires up without manual tracking code on every button:
     - **Tab Routing**: Auto-captures tab switches (`timetable`, `bookings`, `autobook`, `credits`, `settings`).
     - **Declarative Element Tracking**: Any element with `data-track="<action>"` or standard buttons inside modals automatically logs interaction events.
     - **Funnel Tracking**:
       - Auto-Book creation funnel (Timetable Class Click -> Modal Open -> Spot Selection -> Auto-Book Saved).
       - Buy Credits funnel (Credits Tab View -> Bundle Select -> Stripe Modal Launch -> Confirmation).
       - Onboarding completion funnel (Step 1 through Step 6).
     - **PWA Health**: Standalone mode vs. browser tab, iOS version, touch vs. desktop.
   - Batches events in `sessionStorage` and flushes via `navigator.sendBeacon` or throttled `POST /api/analytics/events` to ensure zero impact on user experience.

3. **Server Route Telemetry Middleware**:
   - Express middleware logging route usage, response latency, and status codes into aggregate hourly buckets.

4. **Admin Panel Analytics Interface (`/admin` Analytics Section)**:
   - **Active Users**: Daily Active Users (DAU), Weekly Active Users (WAU), Month-over-Month retention curves.
   - **Feature Adoption Rates**: Bar charts showing % of users who use:
     - Auto-Book queue vs. Manual timetable booking.
     - Auto-Upgrade spot monitoring.
     - Shared studio spot maps vs. list-only selection.
     - Calendar (.ics) subscription integration.
   - **Conversion Funnels**: Visual drop-off steps for booking flows and credit checkout.

---

### C8-3: Filterable Live View of User Class Attendance & Schedule

#### Why This Exists
Today, admin visibility into bookings is fragmented across individual user drawers. A unified, filterable roster provides a real-time command center for all scheduled classes.

#### Gym-Agnostic Design
* **Data Sources**:
  * Unified query over `booking_ledger` (with fallback to `booking_cache` and `calendar_classes`).
* **Dynamic Multi-Select Filtering**:
  * **Gym**: Populated dynamically from `gymsConfig.listGyms()`.
  * **Location & Studio**: Populated dynamically from studios present in the database.
  * **Discipline / Format**: Filter by `Ride`, `Boxing`, `Barre`, `Strength` (read from normalized `discipline`).
  * **Time Range**: `Today`, `Tomorrow`, `This Week`, `Next 7 Days`, `Past 30 Days`, custom range.
  * **Status**: `Confirmed`, `Waitlisted`, `Auto-Book Queued`, `Completed / Attended`.
  * **User Search**: Instant filter by user name or email.
* **Class Collisions & Cohort Grouping**:
  * Group upcoming classes by `(gym_id, start_at, studio_name)`.
  * Highlights classes where **multiple Sweat Assistant users are in the same session**.
  * Shows all user spots (e.g. User A on Bike 14, User B on Bike 15).
* **Interactive Studio Spot Map**:
  * Clicking any class row opens an admin spot map (powered by `spotmap.js`) showing occupied spots, available spots, and which spots belong to Sweat Assistant users.

---

### C8-4: Cross-Gym User Usage & Individual Intelligence

#### Why This Exists
Provides a complete 360-degree view of an individual's training habits across all linked gyms.

#### Gym-Agnostic Design
* **Cross-Gym Split & Loyalty**:
  * Breakdown of workouts across linked gyms (e.g. 65% Psycle, 35% JAB Boxing).
  * Discipline diversity chart derived from normalized event categories.
* **Credit Velocity & Expiry Radar**:
  * Inspects harvested `user_credit_packages`.
  * **Expiry Radar**: Flags credits expiring within 7 days where the user lacks upcoming bookings to use them.
  * **Burn Velocity**: Average credits consumed per week vs. days of runway remaining.
* **Automation Performance**:
  * **Auto-Book Win Rate**: % of scheduled auto-bookings that successfully secured a spot; % that secured their #1 preferred spot vs. fallback spots.
  * **Upgrade Promotions**: Number of spots gained via `auto_upgrades`.
* **Connectivity & Push Health**:
  * Token expiration timers and C6-4 relogin health (`relogin_failures`, `relogin_rejections`, `status`).
  * Registered Web Push devices (iOS Safari PWA, macOS Chrome, etc.) and last delivery timestamp.

---

### C8-5: Per-Gym Fleet Analytics & Platform Health

#### Why This Exists
Ensures administrators have high-level visibility into gym adapter health, rate limits, and timetable release competition.

#### Gym-Agnostic Design
* **Gym Ecosystem Share**:
  * Active users linked per gym, total bookings created, total credits held.
* **Battleground Class Heatmap**:
  * Aggregates pending `auto_bookings` grouped by class and studio.
  * Highlights high-demand sessions where multiple users are queued for the same release window.
* **Provider Reliability Dashboard**:
  * **Latency Tracking**: Average response time for provider reads (`fetchMetadata`, `fetchTimetable`, `listBookings`) grouped by gym.
  * **Rate Limit (429) & Backoff Monitor**: Reads active backoff events and cooldown timers from `rate-limit-backoff.js`.
  * **Release Policy Status**: Live indicator showing each gym's configured booking window policy (rolling weekly vs. rolling daily) and computed next release timestamp.

---

### C8-6: Day-to-Day Operational Diagnostics & Release War Room

#### Why This Exists
Empowers the admin to troubleshoot issues, test integrations, and monitor releases without checking server terminal logs.

#### Gym-Agnostic Design
* **The Release "War Room" (Live Scheduler Monitor)**:
  * Dynamic countdown to the next booking window release for each gym.
  * Pre-release queue manifest showing all auto-book entries sorted by execution offset (`(priority - 1) * PRIORITY_STEP_MS`).
  * Live Server-Sent Events (SSE) execution log streaming timestamps, latency ms, HTTP status codes, and slot allocations.
* **Diagnostic Actions**:
  * **Test Push Delivery**: One-click dispatch of a test push notification to verify user device VAPID tokens.
  * **Force Credential Verification**: Immediate dry-run login against the gym provider to verify credentials.
  * **Trigger Targeted Upgrade Poll**: Run an immediate spot upgrade check for a single user/booking.
* **Read-Only Impersonation ("View App as User")**:
  * View-only modal rendering the client PWA populated with that user's session data to reproduce bug reports.

---

### C8-7: Batch Operations & Pre-Flight Fleet Sweeps

#### Why This Exists
Streamlines administrative fleet tasks across multiple accounts.

#### Gym-Agnostic Design
* **Bulk Priority Tier Management**:
  * Adjust priority tiers for subsets of users (e.g. beta cohort or VIP boosts).
* **Targeted Push / Banner Broadcasts**:
  * Dispatch instant push notifications or in-app modal alerts targeted globally, by linked gym, or by booked studio.
* **Pre-Flight Sunday Release Sweep**:
  * Automated pre-release health sweep running ahead of major release windows:
    * Verifies that all users with queued auto-bookings have unexpired JWTs.
    * Verifies that queued users possess at least 1 usable credit.
    * Detects overlapping class conflicts across different gyms.
    * Generates a pre-flight report highlighting accounts requiring attention before the release fires.

---

## Data Model Extensions (`db.js`)

```sql
-- 1. Immutable System Event Ledger (C8-1)
CREATE TABLE IF NOT EXISTS system_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT DEFAULT CURRENT_TIMESTAMP,
  event_type TEXT NOT NULL,
  user_id INTEGER,
  gym_id TEXT,
  level TEXT DEFAULT 'info',
  payload TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (gym_id) REFERENCES gyms(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_system_events_type_time ON system_events(event_type, timestamp);
CREATE INDEX IF NOT EXISTS idx_system_events_user_gym ON system_events(user_id, gym_id);

-- 2. Durable Booking Lifecycle Ledger (C8-1)
CREATE TABLE IF NOT EXISTS booking_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  gym_id TEXT NOT NULL,
  booking_id INTEGER NOT NULL,
  event_id INTEGER,
  start_at TEXT NOT NULL,
  class_name TEXT,
  group_name TEXT,
  instructor_name TEXT,
  studio_name TEXT,
  location_name TEXT,
  slot_label TEXT,
  initial_slot_label TEXT,
  booked_by TEXT DEFAULT 'quickbook', -- quickbook, autobook, upgrade, external_import
  status TEXT DEFAULT 'confirmed',   -- confirmed, attended, cancelled, no_show, upgraded
  credits_cost REAL DEFAULT 1.0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (gym_id) REFERENCES gyms(id),
  UNIQUE(user_id, gym_id, booking_id)
);
CREATE INDEX IF NOT EXISTS idx_booking_ledger_start ON booking_ledger(start_at);
CREATE INDEX IF NOT EXISTS idx_booking_ledger_user ON booking_ledger(user_id, start_at);

-- 3. Harvested User Credit Packages (C8-1)
CREATE TABLE IF NOT EXISTS user_credit_packages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  gym_id TEXT NOT NULL,
  package_id TEXT,
  package_name TEXT NOT NULL,
  credits_total INTEGER,
  credits_remaining REAL NOT NULL,
  expires_at TEXT,
  purchased_at TEXT,
  synced_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (gym_id) REFERENCES gyms(id)
);

-- 4. Feature Usage Analytics Events (C8-2)
CREATE TABLE IF NOT EXISTS analytics_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  user_id INTEGER,
  timestamp TEXT DEFAULT CURRENT_TIMESTAMP,
  event_category TEXT NOT NULL,
  event_action TEXT NOT NULL,
  event_label TEXT,
  gym_id TEXT,
  metadata TEXT,
  is_pwa INTEGER DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_analytics_events_time ON analytics_events(timestamp);
CREATE INDEX IF NOT EXISTS idx_analytics_events_action ON analytics_events(event_action, timestamp);
```

---

## Acceptance Criteria

1. **True Gym-Agnostic Guarantee**:
   - Zero hardcoded gym IDs anywhere in C8 routes, analytics trackers, or UI code. Verified by `test-no-gym-privilege.js`.
   - Onboarding a 3rd mock gym immediately integrates into all attendance rosters, filters, credit charts, and analytics without code changes.
2. **Data Durability**:
   - Historical bookings in `booking_ledger` survive cache invalidations and provide reliable long-term attendance trends.
   - Profile harvester gracefully handles API limits and populates normalized credit package records.
3. **Integrated Analytics Zero-Overhead**:
   - Analytics events are batched and stored locally in SQLite with sub-millisecond write latency in WAL mode.
   - Ad-blockers cannot disrupt application telemetry because events are routed same-origin via `/api/analytics/events`.
4. **Diagnostic Safety**:
   - All diagnostic triggers and batch operations require verified `{ admin: true }` JWT tokens.
   - Passwords and sensitive session secrets are never logged in `system_events` or exposed to the client.
