# CodexFit API Documentation for Psycle

This document catalogues the relevant endpoints, JSON schema structures, and required authentication headers for the Psycle (`codexfit.com`) backend.

## Global Headers & Authentication

For public endpoints, a standard `GET` request without special headers will suffice.
For user-specific (private) endpoints, the request **must** mimic an authenticated browser session, incorporating the user's JSON Web Token (JWT).

**Required Headers for User Endpoints:**
```http
accept: application/json
accept-language: en-GB,en-US;q=0.9,en;q=0.8
authorization: Bearer <USER_JWT_TOKEN>
origin: https://psyclelondon.com
priority: u=1, i
referer: https://psyclelondon.com/
sec-ch-ua: "Chromium";v="148", "Google Chrome";v="148", "Not/A)Brand";v="99"
sec-ch-ua-mobile: ?0
sec-ch-ua-platform: "macOS"
sec-fetch-dest: empty
sec-fetch-mode: cors
sec-fetch-site: cross-site
sec-fetch-storage-access: active
user-agent: <BROWSER_USER_AGENT>
x-organisation: [object Object]
```

---

## Public Endpoints (No Auth Required)

These endpoints provide structural data required for the timetable grid and metadata mapping.

### 1. Events (Timetable)
- **URL:** `GET https://psycle.codexfit.com/api/v1/customer/events`
- **Params:** `location` (e.g., `1`), `start` (e.g., `2026-06-10 00:00:00`), `end` (e.g., `2026-06-23 00:00:00`)
- **Description:** Returns the timetable for a specific location within a date range.
- **Key Fields in `data[]`:**
  - `id`: Event ID.
  - `start_at`: Class start time.
  - `duration`: Length of the class.
  - `status`: "upcoming", "finished", etc.
  - `capacity` / `occupancy`: Spots available.
  - `is_fully_booked`, `is_waitlistable`.
  - `required_credits`: Number of credits needed to book.
  - `credit_types`: Types of credits accepted for this class.
  - `event_type_id`, `instructor_id`, `studio_id`.

### 2. Locations
- **URL:** `GET https://psycle.codexfit.com/api/v1/customer/locations`
- **Description:** Returns the list of business locations (e.g., Oxford Circus).
- **Key Fields:** `id`, `name`, `address`.

### 3. Studios (Rooms)
- **URL:** `GET https://psycle.codexfit.com/api/v1/customer/studios`
- **Description:** Specific rooms inside the locations.
- **Key Fields:** `id`, `location_id`, `name`, `occupancy`, `layout`.

### 4. Instructors
- **URL:** `GET https://psycle.codexfit.com/api/v1/customer/instructors`
- **Description:** Data on the class instructors.
- **Key Fields:** `id`, `first_name`, `last_name`, `full_name`, `image_1`.

### 5. Event Types & Groups
- **URL (Types):** `GET https://psycle.codexfit.com/api/v1/customer/event-types`
- **URL (Groups):** `GET https://psycle.codexfit.com/api/v1/customer/event-type-groups`
- **Description:** Defines the kinds of workouts available.

### 6. Bundles
- **URL:** `GET https://psycle.codexfit.com/api/v1/customer/bundles`
- **Description:** List of purchasable credits/bundles (including unlisted).

---

## Private Endpoints (Auth Required)

These endpoints dictate the user's booking privileges, current bookings, and actions.

### 1. User Profile
- **URL:** `GET https://psycle.codexfit.com/api/v1/customer/profile`
- **Description:** Retrieves user contact info and booking cutoffs based on their tier/permissions.
- **Key Fields:** `booking_cutoff`, `extended_cutoff`.

### 2. User Credits
- **URL:** `GET https://psycle.codexfit.com/api/v1/customer/credits?page=1&type=unused&per_page=999`
- **Description:** Lists credits the user holds. `type=unused` is strictly required to prevent receiving massive payloads of expired credits.
- **Usage:** Check this list against the `credit_types` of an event to determine if the user can book it.

### 3. Active Bookings
- **URL:** `GET https://psycle.codexfit.com/api/v1/customer/bookings?limit=10&page=1`
- **Description:** Returns the active classes the user is currently booked into.

### 4. Active Waitlists
- **URL:** `GET https://psycle.codexfit.com/api/v1/customer/waitlists?page=1`
- **Description:** Returns the active class waitlists the user is on.

### 5. Subscriptions
- **URL:** `GET https://psycle.codexfit.com/api/v1/customer/subscriptions`
- **Description:** Retrieves recurring plans/memberships.

---

## Heartbeat Endpoint (Cache Invalidation)

> **Discovery method:** Browser network inspection of the authenticated psyclelondon.com website. The CodexFit Vue app (`api-v2.codexfit.com/latest/app.js`) calls this endpoint once on page load to determine which data types need re-fetching.

### Endpoint
- **URL:** `GET https://psycle.codexfit.com/api/v1/customer/heartbeat`
- **Auth:** Works with or without JWT. Without auth, returns public data types only + `logged-in: false`. With auth, adds user-specific data types + `logged-in: true`.
- **Headers:** Same as all customer endpoints (`Authorization`, `x-organisation`, `accept`, `origin`, `referer`).

### Response (Authenticated)
```json
{
  "data": {
    "bundles": "2026-06-23T14:00:51.348759Z",
    "bundle-types": "2026-06-23T14:00:51.348759Z",
    "credit-types": "2026-06-23T14:00:51.348759Z",
    "events": "2026-06-23T14:00:51.348759Z",
    "event-type-groups": "2026-06-23T14:00:51.348759Z",
    "event-types": "2026-06-23T14:00:51.348759Z",
    "instructors": "2026-06-23T14:00:51.348759Z",
    "locations": "2026-06-23T14:00:51.348759Z",
    "plans": "2026-06-23T14:00:51.348759Z",
    "products": "2026-06-23T14:00:51.348759Z",
    "product-variants": "2026-06-23T14:00:51.348759Z",
    "studios": "2026-06-23T14:00:51.348759Z",
    "videos": "2026-06-23T14:00:51.348759Z",
    "videos-collections": "2026-06-23T14:00:51.348759Z",
    "logged-in": true,
    "bookings": "2026-06-23T14:00:51.348759Z",
    "charges": "2026-06-23T14:00:51.348759Z",
    "credits": "2026-06-23T14:00:51.348759Z",
    "subscriptions": "2026-06-23T14:00:51.348759Z"
  }
}
```

### Response (Unauthenticated)
Same structure but:
- `"logged-in": false`
- Omits `bookings`, `charges`, `credits`, `subscriptions` (user-specific data types)

### Data Types

**Public (always returned):**

| Key | Description | Maps to endpoint |
|-----|-------------|-----------------|
| `bundles` | Credit bundles available for purchase | `GET /bundles` |
| `bundle-types` | Bundle categories | — |
| `credit-types` | Credit type definitions | — |
| `events` | Class timetable events | `GET /events` |
| `event-type-groups` | Event type groupings | `GET /event-type-groups` |
| `event-types` | Event type definitions | `GET /event-types` |
| `instructors` | Instructor profiles | `GET /instructors` |
| `locations` | Studio locations | `GET /locations` |
| `plans` | Membership plans | `GET /plans` |
| `products` | Shopify products | — |
| `product-variants` | Product variants | — |
| `studios` | Studio rooms | `GET /studios` |
| `videos` | Video content | — |
| `videos-collections` | Video collections | — |

**Authenticated only:**

| Key | Description | Maps to endpoint |
|-----|-------------|-----------------|
| `bookings` | User's active bookings | `GET /bookings` |
| `charges` | User's payment history | — |
| `credits` | User's credit balance | `GET /credits` |
| `subscriptions` | User's memberships | `GET /subscriptions` |
| `logged-in` | Authentication status (boolean, not a timestamp) | — |

Each value (except `logged-in`) is an ISO 8601 UTC timestamp representing the server's last-modified time for that data type. All timestamps are typically identical (set to the current request time), suggesting the server returns the current time rather than actual per-type modification times — meaning **every page load marks all data as stale** unless the client has a pre-existing local timestamp from a prior fetch in the same session.

### Purpose: Smart Cache Invalidation

The heartbeat is a **cache invalidation mechanism**. Instead of blindly re-fetching all data on page load, the client:

1. Calls `GET /heartbeat` to get the server's latest timestamps for each data type
2. Compares each `remote` timestamp against its `local` cached timestamp (using moment.js `isAfter()`)
3. Marks data types as `stale: true` if the server timestamp is newer than local (or if no local cache exists)
4. Re-fetches only the stale data types
5. After each successful fetch, dispatches `heartbeat/update` which copies `remote[key] → local[key]` and sets `stale[key] = false`

### Client-Side Implementation (CodexFit Vue App)

The heartbeat is a **Vuex store module** (`heartbeat`) registered in the root store:

**State:**
```javascript
{
  loading: false,        // whether a heartbeat request is in flight
  stale: { ... },        // map: data type → boolean (needs re-fetch?)
  local: { ... },        // map: data type → timestamp (client's last fetch time)
  remote: { ... }        // map: data type → timestamp (server's latest update time)
}
```

**Mutations:**
- `loading(state, val)` — sets `state.loading`
- `stale(state, { key, value })` — sets `state.stale[key] = value`
- `remote(state, data)` — sets `state.remote = data`
- `updateLocal(state, key)` — sets `state.local[key] = state.remote[key]` and `state.stale[key] = false`

**Actions:**
- `load` — Fetches `GET /heartbeat`, stores response in `remote`, then for each key:
  - If `local[key]` exists: compares `moment(remote[key]).isAfter(moment(local[key]))` → `stale[key] = true/false`
  - If `local[key]` doesn't exist: `stale[key] = true` (no local cache → always stale)
  - Checks `logged-in`: if server says `false`/`0` but client has a customer → triggers logout
  - Guarded by `loading` flag to prevent concurrent requests
- `update(key)` — Called after any data type is successfully fetched. Commits `updateLocal` to mark the data type as fresh.

**Trigger:**
- Called **once** in the root Vue component's `beforeCreate` hook: `this.$store.dispatch("heartbeat/load")`
- **Not periodic** — no `setInterval`/`setTimeout`. Only fires on page load / full navigation.
- The Vuex state is persisted to `localStorage` under `codex-store` (key: `heartbeat`), so the `local` timestamps survive page reloads, enabling cross-session stale detection.

### Response Headers
- `content-type: application/json`
- `cache-control: no-cache, private`
- `content-encoding: zstd` (compressed)
- CORS: `access-control-allow-origin: https://psyclelondon.com`, `access-control-allow-credentials: true`, `access-control-allow-methods: GET`

### Relevance to PWA

The PWA does not currently use the heartbeat endpoint. It uses its own caching strategy (IndexedDB with 4hr TTL + Monday 12PM force-refresh). Potential uses:

1. **Optimize cache freshness** — Replace the fixed 4hr TTL with a heartbeat check to only re-fetch data types that have actually changed on the server
2. **Lightweight session validation** — The `logged-in` field is a cheaper session check than fetching the full profile (currently the PWA's `triggerAutoRelogin` on 401 is reactive rather than proactive)
3. **Selective refresh** — After a booking/cancel action, call heartbeat to see if `bookings` or `credits` timestamps changed, then refresh only those

---

## Action Endpoints (Auth Required)

### 1. Book a Class
- **URL:** `POST https://psycle.codexfit.com/api/v1/customer/bookings`
- **Payload:** `{"event_id": 205627, "slots": [17]}`
- **Note:** The `slots` array must contain an ID of an available slot on the floor map. Ensure the class hasn't passed the booking cutoff time.

### 2. Cancel a Booking
- **URL:** `DELETE https://psycle.codexfit.com/api/v1/customer/bookings/[booking_id]`
- **Description:** Cancels the booking.
- **Rules:** Cancellation is penalty-free if > 12 hours before class. Otherwise, the credit is lost.
- **1-minute grace window:** The native CodexFit Vue app implements a client-side "undo" window. For the first 60 seconds after `booked_at`, a booking is considered freely cancellable with no penalty — the UI shows a cancel/undo affordance. This is enforced by the `canCancelBooking(slot)` function:
  ```javascript
  canCancelBooking: function(slot) {
    var booking = this.bookings.find(b => b.slot == slot);
    return !(!this.autoBook || booking == null)
      && moment(booking.booked_at).add(1, 'minute').isAfter(moment());
  }
  ```
  The cancel call itself is the same `DELETE /bookings/{id}` endpoint — there is no separate grace-cancel endpoint. The 1-minute window is a UI/client concept; whether the server waives the penalty for cancels within 60s of booking is unverified (the penalty rule is otherwise enforced server-side at the 12-hour mark). The extension and PWA both replicate the 12-hour penalty check client-side (`diffHours < 12`) for confirmation prompts, but do not currently surface the 1-minute undo window.

### 3. Join a Waitlist
- **URL:** `POST https://psycle.codexfit.com/api/v1/customer/waitlists/[event_id]`
- **Description:** Puts user on waitlist for a full class. Slot selection is not possible here.

### 4. Leave a Waitlist
- **URL:** `DELETE https://psycle.codexfit.com/api/v1/customer/waitlists/[event_id]`
- **Description:** Removes user from waitlist (always penalty-free).

---

## Bookmark Endpoints (Auth Required)

These endpoints allow reading and managing native bookmarked classes. Bookmarks are stored in the user profile under `metafields.public.bookmarks.events`.

### 1. Add a Bookmark
- **URL:** `PUT https://psycle.codexfit.com/api/v1/customer/profile/metafields/bookmarks.[namespace].[identifier]`
  - Namespace is typically `events`.
  - Identifier is the generated string representation of the slot (see below).
- **Payload:** `{"data": "[identifier]"}`
  - Example payload: `{"data": "1380000100001930"}`

### 2. Remove a Bookmark
- **URL:** `DELETE https://psycle.codexfit.com/api/v1/customer/profile/metafields/bookmarks.[namespace].[identifier]`

### 3. Clear All Bookmarks in Namespace
- **URL:** `DELETE https://psycle.codexfit.com/api/v1/customer/profile/metafields/bookmarks.[namespace]`

### 4. Bookmark Identifier Generation Formula
Bookmark identifiers are resilient to instructor or class name changes because they target specific recurring studio slots.
The identifier is constructed using:
`[studio_id] + "0000" + [day_of_week] + "0000" + [HHmm]`

Specifically:
- **`studio_id`**: The ID of the studio room (e.g. `108` for Ride Studio 1).
- **`day_of_week`**: Day of the week integer formatted as a single character (`d`). In Moment.js, `0` represents Sunday, `1` represents Monday, ..., `6` represents Saturday.
- **`HHmm`**: 24-hour start hour and minute (e.g. `0630` for 6:30 AM, `1930` for 7:30 PM).

**JavaScript implementation:**
```javascript
function generateBookmarkIdentifier(event) {
  // Using Moment.js:
  const t = moment(event.start_at);
  return event.studio.id + "0000" + t.format("d0000HHmm");
}
```

---

## Undocumented Endpoints — Spot Swapping (Experimental)

> **Discovery method:** Unauthenticated probing of the CodexFit Laravel backend. Laravel resolves routes before the auth middleware runs, so a route that exists returns `401 Unauthenticated` while a non-existent route returns `404`. The `OPTIONS` method returns an `Allow:` header listing all HTTP verbs a route accepts. ~70 endpoints were probed with 2–5s random jitter between requests.

### Background: Current spot-swap approach

Neither the Chrome extension nor the native website has an atomic "swap spot" operation. Both use a **cancel-then-rebook** pattern:

1. `DELETE /bookings/{bookingId}` — cancel the current slot (may incur penalty if < 12h before class)
2. `POST /bookings` with `{ event_id, slots: [newSlotId] }` — book the new slot

This is risky: if step 1 succeeds but step 2 fails (slot taken, network error), the user loses their original spot with no guarantee of getting a new one. If the class is within 12 hours, the cancel also forfeits the credit.

### Discovery: `PUT` and `PATCH` exist on `bookings/{id}`

The `OPTIONS /api/v1/customer/bookings/{id}` preflight returns:

```
Allow: GET, HEAD, PUT, PATCH, DELETE
```

The documented API only describes `POST /bookings` (create) and `DELETE /bookings/{id}` (cancel). The `GET`, `PUT`, and `PATCH` methods on `bookings/{id}` are **undocumented and unused by the native CodexFit Vue app** (confirmed by searching the minified `app.js` — the app only calls `yt().delete("bookings/" + id)` and `yt().post("bookings", {event_id, slots})`).

These methods likely come from a Laravel resource controller (`Route::resource('bookings', ...)`) which auto-registers `GET/{id}` (show), `PUT/{id}` (full replace), and `PATCH/{id}` (partial update).

### What this could enable

If `PATCH /bookings/{id}` accepts a slot change payload (e.g. `{"slots": [newSlotId]}` or `{"slot_id": newSlotId}`), it would allow **atomic spot swapping** — changing bikes in a single request without the cancel-then-rebook race condition. This would be a significant improvement for:

- **Auto-Upgrade**: Currently cancels + rebooks. An atomic swap would eliminate the race window and potentially avoid the penalty check entirely.
- **Manual spot changes** in the PWA's booking modal (the extension's edit-booking flow at `content.js:5452` does cancel-then-rebook in a loop).
- **Quick-Book** when a user already has a booking for the same class and wants to move spots.

### Endpoints confirmed to exist (return 401 unauthenticated)

| Method | Endpoint | Documented? | Used by native app? |
|--------|----------|-------------|---------------------|
| `GET` | `/api/v1/customer/bookings/{id}` | No | No |
| `PUT` | `/api/v1/customer/bookings/{id}` | No | No |
| `PATCH` | `/api/v1/customer/bookings/{id}` | No | No |
| `DELETE` | `/api/v1/customer/bookings/{id}` | Yes | Yes |
| `POST` | `/api/v1/customer/bookings` | Yes | Yes |

### Endpoints confirmed NOT to exist (return 404)

All of these were probed and returned 404 — no dedicated swap/transfer/change endpoints:

- `POST /bookings/{id}/swap`, `/change-slot`, `/change`, `/move`, `/update`, `/modify`, `/reschedule`
- `PUT/PATCH/POST /bookings/{id}/slots`
- `POST /bookings/{id}/transfer`, `/rebook`, `/recurring`
- `POST /transfers`, `GET /transfers`, `POST /swaps`, `GET /swaps`
- `POST /bookings/{id}/cancel`, `/grace-cancel`, `/release`, `/refund`, `/restore`
- `GET /penalties`, `/cancellations`, `/refunds`, `/bookings/{id}/penalty`

### No grace-cancel / no-penalty endpoint

There is no separate endpoint for penalty-free cancellation. The only cancel mechanism is `DELETE /bookings/{id}`. Query parameters like `?grace=true`, `?no_penalty=true`, `?penalty=false`, `?force=true` all hit the same DELETE route (Laravel does not route on query strings) — whether the controller **reads** those params is unverified but unlikely given the native app passes no params.

### Other undocumented endpoints discovered

| Method | Endpoint | Status | Notes |
|--------|----------|--------|-------|
| `POST` | `/api/v1/customer/waitlists` | 401 (exists) | Collection-level waitlist join; native app uses singular `waitlist/{event_id}` instead |
| `GET` | `/api/v1/customer/waitlists/{id}` | 401 (exists) | Single waitlist detail |
| `PATCH` | `/api/v1/customer/waitlists/{id}` | 401 (exists) | Partial waitlist update |
| `GET` | `/api/v1/customer/credits/{id}` | 401 (exists) | Single credit detail |
| `PUT`/`PATCH` | `/api/v1/customer/credits/{id}` | 401 (exists) | Credit update |
| `GET` | `/api/v1/customer/cancel_reasons` | **200 (public)** | Returns cancel reason list — but for **subscription** cancels, not bookings |

### Recommended authenticated tests

The following require a valid JWT to investigate further. Test against a real booking ID (ideally one > 12h out to avoid accidental penalties):

1. **`GET /api/v1/customer/bookings/{realBookingId}`** — Inspect the response shape. Does it include penalty status, cancellation window, or slot details? This tells us what data is available.
2. **`PATCH /api/v1/customer/bookings/{realBookingId}`** with `{"slots": [newSlotId]}` — Does it atomically swap the spot? If successful, this is the holy grail for auto-upgrade.
3. **`PUT /api/v1/customer/bookings/{realBookingId}`** with `{"event_id": ..., "slots": [newSlotId]}` — Full replace variant. May require the full booking object.
4. **`PATCH /api/v1/customer/bookings/{realBookingId}`** with `{"slot_id": newSlotId}` — Alternative payload shape (singular vs array).
5. **`DELETE /api/v1/customer/bookings/{realBookingId}?grace=true`** — Verify whether the controller reads the query param (low probability, but cheap to test).

### Implementation notes for an agent attempting this

- **Test safely first:** Use `GET /bookings/{id}` to inspect the response shape before attempting any mutation. Use a booking that is > 12 hours away to avoid penalties during testing.
- **Payload shapes are unknown:** The `PATCH`/`PUT` body format is undocumented. Try `{"slots": [id]}` first (matches the `POST /bookings` shape), then `{"slot_id": id}`, then `{"slot": id}`. Inspect error responses (422 validation errors often reveal expected field names).
- **Check for penalty bypass:** If `PATCH` succeeds for a booking within 12h of class start, compare credit balance before/after to determine if the penalty was waived (swap) or still applied.
- **Server integration:** If atomic swap works, `server/poller.js` `attemptUpgradeSlot()` and the client's edit-booking modal (`client/src/ui/timetable.js` / `bookings.js`) should be updated to use `PATCH /bookings/{id}` instead of cancel-then-rebook. The proxy in `server/server.js` (`/api/proxy/*`) already supports arbitrary methods.
- **Fallback:** Keep the cancel-then-rebook path as a fallback if `PATCH` returns 405/422/403 for slot changes — the endpoint may exist but not accept slot modifications.

