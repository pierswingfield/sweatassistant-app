# Sweat Assistant — Project Backlog

This document tracks all open feature requests, bugs, technical debt, and future architectural tasks.

---

## 1. Deferred Immediate Fixes
These are immediate bug fixes and enhancements prioritized by the user, to be addressed in the next coding phase.

### Timetable Scheduled Indicators (Bug)
* **Description**: Classes that are already queued for Auto-Book do not display the "Scheduled" indicator in the timetable view.
* **Details**: Fix the mapping issue in `client/src/ui/timetable.js` where `autoBookedIds` Set matches on `x.eventId` instead of the DB schema's `x.event_id` field.

### Deep Link Notifications (Feature)
* **Description**: Support deep linking when clicking Web Push notifications.
* **Details**: Clicking a booking or upgrade notification should automatically navigate the client PWA to the "My Bookings" tab, rather than just reloading the main page.

### Multi-spot Auto-Upgrades (Bug)
* **Description**: Ensure booking multiple spots in the same class correctly registers individual upgrade monitors for each slot.
* **Details**: Currently, the server maps multiple upgrades by the same `booking_id` (or maps them with ID `0`), leading the poller to only track a single active monitor. Reconcile booking ID resolution in `scheduler.js` and active monitor mapping in `admin.js`.

### Auto-Upgrade Poller Cancel Boundary (Enhancement)
* **Description**: Stop auto-upgrade polling 5 seconds before the 12-hour free cancellation boundary.
* **Details**: Prevents the poller from attempting a spot swap right at the boundary where a cancel-then-rebook could fail and trigger a late cancellation penalty.

### Unauthenticated Public API Requests (Security)
* **Description**: Query class and studio availability details without Bearer JWT headers for tooltips and poller checks.
* **Details**: Reduces account-flagging risk by limiting the exposure and rate of authorized token hits on CodexFit.

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
