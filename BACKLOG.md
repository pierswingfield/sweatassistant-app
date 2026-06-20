# Backlog

## In-app 3-D Secure support for credit purchases

### Context
- In-app credit checkout is fully server-driven via the BFF proxy (`POST /api/cart/checkout/init/:bundleId` + `POST /api/cart/checkout/confirm` in `server/server.js`). It charges a saved card off-session and polls `GET /orders/:id` until `Paid`.
- **Gap**: 3-D Secure is not supported. When the saved-card off-session charge requires authentication, Stripe returns `last_payment_error.code = authentication_required` (or the order never leaves `Payment pending`). We currently detect this, return `status: 'requires_action'`, and show a graceful error + website fallback + "tips to avoid 3-D Secure" (`renderPurchaseError(..., secureTips=true)` in `client/src/ui/credits.js`).

### Problem
- A meaningful share of UK cards (esp. Visa/Mastercard under PSD2 SCA) will trigger a challenge on first purchase, so those users are bounced to the website.

### Solution
- The order/payment-intent response already exposes everything needed: `metadata.intent_secret` / `payment_intent.client_secret` (e.g. `pi_..._secret_...`) and the live PaymentIntent.
- Embed **Stripe.js** in the client (publishable key = the org's Stripe account; confirm which from the `pmc_1LVawB2G0LU8CI0RFBqoKtbu` config).
- Flow change:
  1. After `ajaxCheckoutProcess`, when polling yields `requires_action`, return `client_secret` to the client.
  2. Client calls `stripe.confirmCardPayment(clientSecret, { payment_method: pmId })` — this renders the 3-D Secure modal.
  3. On success, re-poll `GET /orders/:id` until `Paid`.
- **Files**: `server/server.js` (return `client_secret` from `/checkout/confirm` on `requires_action`; reuse the poll loop), `client/src/ui/credits.js` (load Stripe.js, run `confirmCardPayment`, re-poll), `client/src/api.js`.
- **Complexity**: M. **Dependencies**: confirm Stripe publishable key; verify the PaymentIntent (not the SetupIntent) is the one to confirm.

---

## Cache event data across users + prioritise same-spot contention

### Problem
- Multiple users may auto-book or auto-upgrade the same Psycle class, causing N identical `GET /events/:id` requests.
- When multiple users want the same slot, they fire `POST /bookings` simultaneously, creating server-side contention and wasted API calls.

### Solution

#### 1. Shared Event Cache

**Data structure** (in-memory Map in `scheduler.js`):
```javascript
const eventCache = new Map(); // eventId → { payload, expiresAt }
```

**Storage**:
- Lives as a module-level variable in `scheduler.js` (not persisted; cleared on restart).
- Keyed by `eventId` (string).
- Stores the full CodexFit event payload (`slots`, `layout`, `relations`, etc.).

**TTL strategy**:
- **Prefetch window (T-50s to T-0)**: 30s TTL. Event cache entries created during prefetch are valid for 30 seconds, covering all booking attempts at release.
- **Upgrade checks (per-minute poll)**: 60s TTL. Reuse event data across multiple monitors checking the same event within a 1-minute window.

**Access pattern**:
- Before fetching `GET /events/:id`, check if `eventCache.has(eventId)` and not expired.
- If hit, use cached payload; if miss or expired, fetch and cache.
- Apply to both `prefetchAutoBookSlots()` (scheduler.js) and `attemptUpgradeSlot()` (poller.js).

---

#### 2. Slot Contention Priority Ordering

**Problem**: Users A and B both want slot 42 of event E. Both bookings fire at T-0, both attempt `POST /bookings` simultaneously. One succeeds, one fails. Both wasted a request.

**Solution: Priority queue in `executeAutoBookQueue()`**

- **Priority key**: `created_at` timestamp on the `auto_bookings` record (first-come-first-served).
- **Stagger execution**: Sort bookings by creation time, then stagger the `executeAutoBookForClass()` calls by ~50–100ms per user.
- **Example**:
  - User A (created 1st) → fires at T+0ms
  - User B (created 2nd) → fires at T+80ms
  - User C (created 3rd) → fires at T+160ms

- **Implementation**:
  ```javascript
  async function executeAutoBookQueue(bookings) {
    if (bookings.length === 0) return;
    
    // Sort by creation time (earliest first = highest priority)
    const sorted = bookings.sort((a, b) => 
      new Date(a.created_at) - new Date(b.created_at)
    );
    
    // Fire sequentially with stagger
    const staggerMs = 50 + Math.floor(Math.random() * 50); // 50–100ms
    for (let i = 0; i < sorted.length; i++) {
      if (i > 0) {
        await new Promise(r => setTimeout(r, i * staggerMs));
      }
      executeAutoBookForClass(sorted[i]).catch(err => {
        console.error(`[Scheduler] Worker routine crash for event ${sorted[i].event_id}:`, err.message);
      });
    }
  }
  ```

- **Benefit**: The highest-priority user gets a 50–100ms head start on the API, increasing their success chance for contested slots. Subsequent users still get full booking flow but with a predictable delay.

---

#### 3. Database schema change (optional, for efficiency)

Add `created_at` to `auto_bookings` if not already present (to persist priority order across restarts):
```sql
ALTER TABLE auto_bookings ADD COLUMN created_at DATETIME DEFAULT CURRENT_TIMESTAMP;
```

---

#### 4. Implementation order

1. Add event cache with TTL logic to `scheduler.js`.
2. Hook `prefetchAutoBookSlots()` and `attemptUpgradeSlot()` to use the cache.
3. Add `created_at` to schema (if missing) and seed it for existing records.
4. Implement priority sort + stagger in `executeAutoBookQueue()`.
5. Test: verify cache hits reduce API count; staggered priority booking logs show sequential execution.

---

## Multi-user readiness: rate limiting, landrush arbitration, admin observability, and credential hardening

### Problem
- Data isolation is correct — all 8 SQLite tables are keyed by `user_id`, JWT auth gates every route, the SSE stream is per-user (`GET /api/auto-book/stream`), and push subscriptions are per-user. This holds for ~10–20 users.
- However, the system was designed as a single-user deployment that happens to support many. At scale the following risks emerge:
- **Monday-noon landrush**: `executeAutoBookQueue` fires ALL users' bookings in parallel via `Promise.allSettled` (scheduler.js:372-378) with zero coordination. 10+ users targeting the same class+slot all hit CodexFit `POST /bookings` within ~50ms from the single Pi IP — non-deterministic race, self-competition, and IP-ban risk that takes down ALL users at once.
- **No rate limiting or quotas anywhere** — one user can hammer `/api/proxy/*` or create unbounded auto-book/auto-upgrade entries and get the Pi IP banned for everyone.
- **Single global AES-256-GCM key** encrypts all users' CodexFit passwords, with a DB fallback (crypto.js:10-14) storing the key next to the ciphertext — a DB compromise equals total credential loss.
- **No health/metrics endpoint**, no alerting if the scheduler silently crashes.
- **No admin surface** — can't see credential health, broken relogins, or abuse without raw SQL.
- **Single Node process / single SQLite connection / in-memory SSE registry lost on restart.**

### Solution

Work is split into priority tiers. Each item lists **What / Why (risk mitigated) / Files / Complexity / Dependencies**. Complexities: S ≈ half-day, M ≈ 1–2 days, L ≈ multi-day.

#### P0 — Must-have for safe multi-user (blocking risks)

##### 1. Per-user rate limiting on proxy + booking endpoints

- **What**: Add `express-rate-limit` keyed on `req.userId` (not IP — all users share the Pi egress IP from the client side, but the server sees distinct `userId`s). Apply to `/api/proxy/*` and the booking endpoints (`POST /api/auto-book`, `POST /api/auto-upgrade`, `POST /api/simulate-release`).
- **Why**: One user looping requests can get the shared CodexFit IP banned, taking out all users. Per-user limiting contains the blast radius.
- **Files**: `server/server.js` (middleware on proxy + booking routes).
- **Complexity**: S
- **Dependencies**: none

```javascript
const rateLimit = require('express-rate-limit');

const perUserLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,                    // 60 req/min per user on proxy
  standardHeaders: true,
  keyGenerator: (req) => req.userId || req.ip,
  message: { error: 'Too many requests' },
});

app.use('/api/proxy', perUserLimiter);
// Stricter limiter (10/min) on booking-mutating endpoints.
```

---

##### 2. Per-user quotas: cap auto-book and auto-upgrade entries

- **What**: Reject `POST /api/auto-book` when the user already has ≥15 entries; reject `POST /api/auto-upgrade` when ≥10 active monitors. Add count queries in `db.js`.
- **Why**: Unbounded queue growth = unbounded Monday-noon load and poller load. Quotas cap worst-case scheduler/poller fan-out per user.
- **Files**: `server/server.js` (`POST /api/auto-book`, `POST /api/auto-upgrade` handlers), `server/db.js` (count queries).
- **Complexity**: S
- **Dependencies**: none

```javascript
// db.js
function countAutoBookings(userId) {
  return db.prepare('SELECT COUNT(*) AS n FROM auto_bookings WHERE user_id = ?').get(userId).n;
}
function countActiveAutoUpgrades(userId) {
  return db.prepare("SELECT COUNT(*) AS n FROM auto_upgrades WHERE user_id = ? AND status = 'active'").get(userId).n;
}
```

---

##### 3. Remove encryption key DB fallback — env var only

- **What**: Delete the `server_kv` fallback in `crypto.js:10-14`. `ENCRYPTION_KEY` must come from env; if missing, throw on boot instead of silently generating/storing a key in the same DB as the ciphertext.
- **Why**: Key-in-DB-next-to-ciphertext defeats the entire encryption scheme. A single DB file leak = every user's CodexFit password decrypted.
- **Files**: `server/crypto.js`.
- **Complexity**: S
- **Dependencies**: none. **Coordinate with `deploy.sh` + `docker-compose.yml`** to ensure `ENCRYPTION_KEY` is always provided in prod before shipping this.

```javascript
// crypto.js — before
const key = process.env.ENCRYPTION_KEY || getDbKey('server_encryption_key') || generateAndStore();

// crypto.js — after
const key = process.env.ENCRYPTION_KEY;
if (!key) {
  console.error('[crypto] FATAL: ENCRYPTION_KEY env var is required. Refusing to start.');
  process.exit(1);
}
```

---

##### 4. Health check endpoint + scheduler crash alerting

- **What**: `GET /api/health` returns JSON: `{ schedulerNextFire, pollerLastRun, activeUserCount, pendingBookingCount, uptime }`. Wrap `executeAutoBookQueue` in try/catch with failure logging. Add a watchdog cron (daily) that alerts (console.error + optional push to admin) if `schedulerNextFire` is more than 7 days stale.
- **Why**: Scheduler can silently crash and no one knows until users miss their Monday bookings. Observability baseline.
- **Files**: `server/server.js` (new route), `server/scheduler.js` (export `getNextFireTime()`, try/catch around queue execution).
- **Complexity**: S
- **Dependencies**: none

```javascript
// server.js
app.get('/api/health', (req, res) => {
  res.json({
    schedulerNextFire: scheduler.getNextFireTime()?.toISOString() ?? null,
    pollerLastRun: poller.lastRunAt?.toISOString() ?? null,
    activeUserCount: db.countActiveUsers(),
    pendingBookingCount: db.countPendingBookings(),
    uptime: process.uptime(),
  });
});
```

---

#### P1 — Should-have for 10–50 users

##### 5. Per-user dispatch jitter (0–2000ms) before POST /bookings

- **What**: In `executeAutoBookQueue`, before each user's booking fires, sleep a per-user random `0–2000ms`. Spreads the landrush over ~2s instead of ~50ms.
- **Why**: Reduces CodexFit instantaneous load and IP-ban risk at the release moment. Cheap, ~5 lines, no architectural change.
- **Files**: `server/scheduler.js:368-378`.
- **Complexity**: S
- **Dependencies**: none — but **implement together with #6** (both touch the same dispatch block).

```javascript
const jitterMs = Math.floor(Math.random() * 2000); // 0–2000ms per user
await new Promise(r => setTimeout(r, jitterMs));
```

---

##### 6. Per-class serial dispatch with shuffle — SUPERSEDES the existing backlog entry's "Slot Contention Priority Ordering" subsection

> **Note — relationship to prior art**: The existing backlog entry "Cache event data across users + prioritise same-slot contention" → subsection **"2. Slot Contention Priority Ordering"** proposed a `created_at`-sorted 50–100ms stagger across all bookings. This item **supersedes** that stagger approach: instead of a flat global stagger biased by creation time, we group by `event_id` and process same-class bookings **serially with a random shuffle**, while different classes stay parallel. The existing entry is left intact as prior art; this refines it.
>
> **The existing entry's `created_at` column addition (subsection 3) is still useful and should be kept** — it is no longer the primary fairness mechanism, but it remains valuable as an audit field and as a deterministic tie-break when two bookings are otherwise identical (e.g. a fallback ordering if shuffle ever needs to be made reproducible for debugging). Do not drop the column.

- **What**: Group all pending bookings by `event_id`. Within each group, shuffle the order (cryptographic or `Math.random`) and process sequentially. Across groups, run in parallel. Combined with #5, each user also waits a per-user jitter before their group's turn.
- **Why (why this beats the 50–100ms `created_at` stagger)**:
  - The stagger only *biases* contention toward earlier creators; it does not *eliminate* self-competition — two users after the same slot still both fire `POST /bookings`, just offset by 50–100ms, and both can fail. Serial dispatch within a class means at most one in-flight `POST /bookings` per class at a time, so a succeeded slot is observed before the next attempt (the next attempt can short-circuit or fall back to the user's next-preferred slot).
  - Random shuffle gives **statistical fairness over weeks** without penalising late discoverers the way strict `created_at` ordering does (a user who adds a booking on Saturday shouldn't be permanently behind a user who added Monday).
  - Different classes have independent slots, so parallelism across classes is safe and keeps total wall-clock low.
- **Files**: `server/scheduler.js:368-378` (`executeAutoBookQueue`).
- **Complexity**: M-L (~30 lines)
- **Dependencies**: none; combine with #5 in the same change.

```javascript
async function executeAutoBookQueue(bookings) {
  if (bookings.length === 0) return;

  // Group by class (event_id); different classes stay parallel,
  // same-class bookings run serially with a fair shuffle.
  const groups = new Map();
  for (const b of bookings) {
    if (!groups.has(b.event_id)) groups.set(b.event_id, []);
    groups.get(b.event_id).push(b);
  }

  const groupJobs = [...groups.values()].map(async (group) => {
    // Shuffle for fairness (created_at kept on the row for audit/tie-break only).
    for (let i = group.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [group[i], group[j]] = [group[j], group[i]];
    }
    // Per-user jitter (#5) before the class's first dispatch.
    await new Promise(r => setTimeout(r, Math.floor(Math.random() * 2000)));
    // Serial within class: observe each result before the next attempt.
    for (const b of group) {
      try { await executeAutoBookForClass(b); }
      catch (err) { console.error(`[Scheduler] event ${b.event_id} user ${b.user_id}:`, err.message); }
    }
  });

  await Promise.allSettled(groupJobs);
}
```

---

##### 7. CodexFit response monitoring + abort-on-429/403

- **What**: After each `POST /bookings`, log the CodexFit status code. If CodexFit returns 429 (rate-limited) or 403 (blocked), set a global "CodexFit distressed" flag, stop all in-flight bookings in the current queue, and push-notify affected users that their auto-book was aborted due to upstream throttling.
- **Why**: Prevents making an IP ban worse by continuing to fire after CodexFit has signalled distress; gives users an actionable notification instead of a silent failure.
- **Files**: `server/scheduler.js:248-257` (booking call site), `server/notifications.js` (new abort notification type or reuse `booking` with an `aborted` context).
- **Complexity**: S
- **Dependencies**: complementary to #4 (shares alerting surface).

---

##### 8. Read-only admin dashboard

- **What**: New `server/admin.js` module + an admin auth middleware (admin flag column on `users` table, or a separate admin allow-list). Routes (read-only, no writes yet):
  - `GET /api/admin/health` — same as #4 but cross-user.
  - `GET /api/admin/users` — email, last login, JWT expiry, active queue counts, credential health (last relogin success/failure).
  - `GET /api/admin/notifications` — paginated `sent_notifications` log.
  - `GET /api/admin/upcoming-release` — next Monday noon + pending bookings grouped by class → user (the landrush preview).
- **Why**: Can't operate a multi-user service blind. Need to spot broken credentials, abuse, and landrush hotspots without raw SQL.
- **Files**: new `server/admin.js`, `server/server.js` (mount routes), `server/db.js` (admin queries), `server/auth.js` (admin middleware).
- **Complexity**: M
- **Dependencies**: shares logic with #4; #9 feeds the credential-health column.

---

##### 9. Track `last_relogin_failure` per user

- **What**: Add a `last_relogin_failure` (DATETIME, nullable) + `relogin_failure_count` (INT) to the `users` table. Record a failure in `auth.js` `triggerAutoRelogin()` when CodexFit re-auth fails.
- **Why**: Lets the admin dashboard (#8) proactively surface users whose stored credentials have stopped working (e.g. password changed on the website) before they miss a Monday booking.
- **Files**: `server/db.js` (schema migration + CRUD), `server/auth.js` (record failures on catch).
- **Complexity**: S
- **Dependencies**: none; feeds #8.

```sql
ALTER TABLE users ADD COLUMN last_relogin_failure DATETIME;
ALTER TABLE users ADD COLUMN relogin_failure_count INTEGER DEFAULT 0;
```

---

##### 10. DB backup mechanism

- **What**: Cron job running `sqlite3 .backup` to a mounted volume (e.g. `/backups/psycle-$(date +%F).db`), retained N days.
- **Why**: SQLite is a single file; without backups a disk/accident event is catastrophic data loss (all users' queues, prefs, encrypted creds).
- **Files**: `docker-compose.yml` (mount a `/backups` volume), a small backup script + cron entry (or host-side cron on the Pi).
- **Complexity**: S
- **Dependencies**: none; schedule anytime in P1.

```bash
# cron: daily 04:00
sqlite3 "$DB_PATH" ".backup '/backups/psycle-$(date +\%F).db'"
find /backups -name 'psycle-*.db' -mtime +14 -delete
```

---

#### P2 — Nice-to-have for 100+ users / public service

##### 11. Per-user key derivation

- **What**: Derive each user's encryption key from the master `ENCRYPTION_KEY` + a per-user salt (stored on the `users` row) via HKDF, instead of using one global key for all ciphertexts.
- **Why**: Limits blast radius — compromise of the master key alone (without salts) is not enough; compromise of one user's salt doesn't help attack others.
- **Files**: `server/crypto.js`, `server/db.js` (salt column).
- **Complexity**: M
- **Dependencies**: #3 (must have removed the DB fallback first).

---

##### 12. Priority-tier queue dispatch

- **What**: Replace the per-release `executeAutoBookQueue` fan-out with a central booking queue that has tiers (e.g. paid / free / trial), FIFO within a tier, processed serially with a global worker.
- **Why**: Lets the operator prioritise users and guarantees a single in-flight `POST /bookings` globally, eliminating all self-competition. Only justified once #5/#6 are insufficient.
- **Files**: `server/scheduler.js` (new queue architecture), `server/db.js`.
- **Complexity**: L
- **Dependencies**: #5, #6.

---

##### 13. PostgreSQL migration

- **What**: Migrate `db.js` from `better-sqlite3` to Postgres (connection pooling, better concurrent writes, mature backup tooling). Update `Dockerfile` + `docker-compose.yml` to run Postgres.
- **Why**: SQLite's single-writer model and single-file nature become friction at high concurrency and for managed backups.
- **Files**: `server/db.js`, `Dockerfile`, `docker-compose.yml`.
- **Complexity**: L
- **Dependencies**: none technically; only justified at high concurrency.

---

##### 14. Competing-booking detection + user-facing odds warning

- **What**: Before T-0, detect multiple users targeting the same `(event_id, slot)` and warn them via the SSE stream (`client/src/ui/autobook.js`); optionally let users set a conflict priority.
- **Why**: Transparency — users currently can't see that 5 people are all aiming at slot 42. Lets them pick a less-contested fallback slot ahead of time.
- **Files**: `server/scheduler.js` (new pre-release scan), `client/src/ui/autobook.js` (SSE UI).
- **Complexity**: L
- **Dependencies**: #6 (relies on serial dispatch to make "odds" meaningful).

---

##### 15. Structured JSON logging + Prometheus metrics

- **What**: Replace ad-hoc `console.error`/`console.log` with structured JSON (timestamps, user IDs, event IDs, statuses). Expose `GET /metrics` (Prometheus format) for booking success rate, CodexFit API latency, queue depth.
- **Why**: Proper observability for a multi-user service; enables dashboards and alerting beyond the basic #4 health endpoint.
- **Files**: all `server/*.js`.
- **Complexity**: M
- **Dependencies**: #4 (builds on the health baseline).

---

#### Implementation order

1. **P0 #3** (remove key fallback) + deploy coordination — security baseline; ship only once `ENCRYPTION_KEY` is guaranteed in prod.
2. **P0 #1, #2** (rate limit + quotas) — abuse prevention.
3. **P0 #4** (health + alerting) — observability baseline.
4. **P1 #5 + #6 together** (jitter + per-class serial dispatch) — landrush fix; this **supersedes** the existing entry's 50–100ms `created_at` stagger while keeping its `created_at` column for audit/tie-break.
5. **P1 #7** (CodexFit response monitoring + abort-on-429) — builds on #4's alerting.
6. **P1 #9** (relogin failure tracking) — feeds the admin dashboard.
7. **P1 #8** (read-only admin dashboard) — consumes #4 and #9.
8. **P1 #10** (DB backup) — independent; schedule anytime during P1.
9. **P2 items** as scale demands (#11 first since it hardens creds, then #15, then #12/#13/#14 if concurrency justifies).
