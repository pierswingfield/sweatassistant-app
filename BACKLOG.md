# Backlog

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
