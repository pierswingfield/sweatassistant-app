# Sweat Assistant — Project Backlog

This document tracks all open feature requests, bugs, technical debt, and future architectural tasks.

---

## 1. Deferred Immediate Fixes

*No immediate fixes are currently deferred. All core items have been successfully resolved and verified.*

---

## 2. Advanced Backlog Items

### In-App 3-D Secure Support
* **Status**: ❌ Open (partial)
* **Spec Link**: [3d_secure_checkout.md](file:///Users/pierswingfield/Desktop/AI%20Projects/psycle%20chrome/App/Documentation/Backlog/3d_secure_checkout.md)
* **Summary**: Embed Stripe.js in the PWA client to complete the 3DS verification modal in-app for credit purchases, rather than bouncing users to the external Shopify site checkout.

### Sweat Assistant Multi-Gym Architecture
* **Status**: ❌ Open (planning)
* **Spec Link**: [sweat_assistant_modular_gyms.md](file:///Users/pierswingfield/Desktop/AI%20Projects/psycle%20chrome/App/Documentation/Backlog/sweat_assistant_modular_gyms.md)
* **Summary**: Refactor the backend proxy, auth system, database, and client timetable layouts to support both CodexFit and Mariana Tek fitness platforms under a single modular codebase.

### CodexFit 429/403 Distress Abort (Tech Debt)
* **Status**: ❌ Open
* **Summary**: Detect when CodexFit begins returning HTTP 429 or 403 blocks during landrush booking execution. In state of distress, abort the remaining queue to protect the server's egress IP and push-notify users.

### Track Relogin Failures per User (Observability)
* **Status**: ❌ Open
* **Summary**: Add database fields to track credential failures during automatic relogins. Proactively flag broken credentials on the Admin Dashboard before Monday release runs.

### SQLite Database Backup Mechanism (DevOps)
* **Status**: ❌ Open
* **Summary**: Set up a background cron backup task on the Pi to back up the SQLite database to a local file volume and prune snapshots older than 14 days.

### Per-User Key Derivation (Security)
* **Status**: ❌ Open
* **Summary**: Derive individual AES encryption keys for each user using HKDF, combining the system master key with unique user-record salts.

### PostgreSQL Migration (Scale)
* **Status**: ❌ Open
* **Summary**: Transition database storage from `better-sqlite3` to PostgreSQL to improve concurrent write performance and simplify database orchestration in production.

### Competing Booking Detection & Conflict Warning (UX)
* **Status**: ❌ Open
* **Summary**: Analyze the scheduler queue to detect when multiple users are targeting the identical slot of a class, and warn them in-app so they can select a fallback option.

### Structured Logging & Metrics (Telemetry)
* **Status**: ❌ Open
* **Summary**: Replace standard `console.log` statements with structured JSON logging and expose a Prometheus metrics endpoint to monitor success rates and API latencies.

---

## 3. Completed Items (Recent)

### Timetable Scheduled Indicators (Bug)
* **Status**: ✅ Completed
* **Resolution**: Standardized the event ID resolution in `client/src/ui/timetable.js` mapping `autoBookedIds` correctly to `x.event_id || x.eventId` (DB schema mapping) to ensure scheduled status is shown accurately.

### Deep Link Notifications (Feature)
* **Status**: ✅ Completed
* **Resolution**: Updated `client/public/sw.js` and `client/src/main.js` to support deep linking on Web Push notifications. Clicking a booking or upgrade notification now focuses the open PWA window and navigates to the `#my-bookings` tab.

### Multi-spot Auto-Upgrades (Bug)
* **Status**: ✅ Completed
* **Resolution**: Solved concurrent booking ID mapping in `scheduler.js` and active monitor mapping in `admin.js`. The scheduler maps each spot individually, and the database stores unique `booking_id` properties for each slot, allowing the poller to track multiple upgrade monitors for the same class concurrently.

### Auto-Upgrade Poller Cancel Boundary (Enhancement)
* **Status**: ✅ Completed
* **Resolution**: Implemented a `CUTOFF_BUFFER_S` of 5 seconds in `server/poller.js`. Auto-upgrade polling now stops 5 seconds before the 12-hour free cancellation boundary to avoid race conditions that could lead to late cancellation penalties.

### Unauthenticated Public API Requests (Security)
* **Status**: ✅ Completed
* **Resolution**: Modified `server/server.js` public paths GET requests (e.g. `/events`, `/studios`) to query CodexFit directly without passing authentication tokens, limiting authorized token hits. Added a safety bypass for `dev@psycle.com` to prevent production leakage into mock environments. Also updated client-side receive listener in `main.js` to clear IndexedDB cache immediately on push, avoiding flash-of-stale-content visual bugs.
