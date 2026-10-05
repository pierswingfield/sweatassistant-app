# Psycle London — CodexFit API & Timetable Documentation

This document serves as the single source of truth for the CodexFit integration on the Psycle London website (`psyclelondon.com`). It details the API endpoints, authentication flows, data structures, and the client-side timetable rendering logic.

---

## 1. Global Headers & Authentication

CodexFit uses JSON Web Tokens (JWT) for user-authenticated endpoints. The PWA communicates with the CodexFit API using a server-side backend-for-frontend (BFF) proxy.

### 1.1 Direct Login (BFF Auth)
While the native website uses Shopify Single Sign-On (SSO) with Multipass tokens, the CodexFit API supports a direct username and password authentication flow. This direct endpoint allows the PWA server to authenticate programmatically and manage user credentials.

```http
POST https://psycle.codexfit.com/api/v1/customer/auth/login
Content-Type: application/json
Origin: https://psyclelondon.com

{
  "email": "user@example.com",
  "password": "password123"
}
```

* **Success (200 OK):** Returns `{ "access_token": "<JWT_TOKEN>", "user": { ... } }`.
* **Failure (500 Internal Server Error):** Returns `{ "message": "Invalid login credentials", "exception": "App\\Exceptions\\PublicLoginException" }`.
* **Validation Failure (422 Unprocessable Entity):** Returns validation errors such as `{ "message": "The email field is required." }`.

### 1.2 Shopify Multipass Login
When a user logs in on the main website via Shopify, Shopify generates a signed, time-limited multipass token. The native Vue app captures this from `window.codex.multipassToken` or the URL parameter `?multipass=` and exchanges it for a JWT:

```http
POST https://psycle.codexfit.com/api/v1/customer/auth/multipass/login
Content-Type: application/json
Origin: https://psyclelondon.com

{
  "multipass_token": "<token>"
}
```

* **Success (200 OK):** Returns `{ "access_token": "<JWT_TOKEN>", "user": { ... } }`.

### 1.3 Required Headers
All requests routed to the CodexFit API must include the following headers to avoid origin blocking and format mismatches:

```http
accept: application/json
origin: https://psyclelondon.com
referer: https://psyclelondon.com/
x-organisation: [object Object]
```

For authenticated endpoints, append the Bearer token:
```http
authorization: Bearer <JWT_TOKEN>
```

*Note: There is no token refresh endpoint. When a JWT expires (usually indicated by an HTTP 401 Unauthorized response), the client/BFF must perform a fresh login using the direct login flow.*

---

## 2. API Endpoints Catalog

### 2.1 Public Endpoints (No Auth Required)

#### Timetable Events
Retrieves class events for a specific location within a date range.
* **Method:** `GET`
* **Path:** `/api/v1/customer/events`
* **Params:** `location` (integer, e.g. `1`), `start` (date string, e.g. `2026-06-14 00:00:00`), `end` (date string, e.g. `2026-06-27 00:00:00`).

#### Event Detail (including slots)
Retrieves detailed information for a single event including room slots layout.
* **Method:** `GET`
* **Path:** `/api/v1/customer/events/{id}`

#### Locations
Lists all studio locations.
* **Method:** `GET`
* **Path:** `/api/v1/customer/locations`

#### Studios
Lists studio rooms and their configuration layouts.
* **Method:** `GET`
* **Path:** `/api/v1/customer/studios`

#### Instructors
Lists instructor profiles, bios, photos, and social links.
* **Method:** `GET`
* **Path:** `/api/v1/customer/instructors`

#### Event Types & Groups
Lists workout types (e.g. Strength, Barre, Ride) and their parent groups.
* **Method:** `GET`
* **Path:** `/api/v1/customer/event-types` / `/api/v1/customer/event-type-groups`

#### Credit Bundles
Lists purchasable bundle products.
* **Method:** `GET`
* **Path:** `/api/v1/customer/bundles` (or `/api/customer/v2/bundles`)

---

### 2.1.1 CodexFit v2 Platform & Query Builder Architecture

CodexFit provides a modern RESTful v2 API under `/api/customer/v2` powered by Laravel and Spatie Query Builder conventions (`filter[field]`, `sort`, `page[size]`). While v1 endpoints remain active for compatibility, the v2 endpoints consolidate relational data and contextual state:

#### Events & Timetable (v2)
* **Method:** `GET`
* **Path:** `/api/customer/v2/events`
* **Query Parameters — corrected 2026-09-26**: a live capture of the real timetable page load
  (`server/fixtures/codexfit-v2/PARITY.md` gate G4) showed **no `filter[location]` param at all** on this
  call — location scoping for that embed happens some other way, not identified in that session — and the
  real site fires **three separate single-day-range calls** on initial load
  (`filter[between]=2026-09-26,2026-09-27`, `...27,28`, `...28,29`, i.e. today + 2 more days), not one wider
  range. `filter[location]` may still be a valid filter per the allowed-filters list below; it just isn't
  what the native timetable actually sends.
  * `filter[location]`: Location ID (e.g. `1` for Oxford Circus). **Not observed live** — see correction above.
  * `filter[between]`: Comma-separated ISO date range (e.g. `2026-09-28,2026-09-29`). **Confirmed live as a single-day range per call**, not a wider span.
  * `sort`: Sort field (`start_at`, `id`, `created_at`, `updated_at`). Prefix `-` for descending (e.g. `sort=start_at`).
  * **Allowed Filters:** `id`, `instructor`, `instructor.handle`, `instructor_tags`, `tags`, `studio`, `studio.handle`, `location`, `location.handle`, `event_type`, `event_type.handle`, `event_type_group`, `event_type_group.handle`, `start_at`, `between`, `is_live_stream`, `is_video_event`, `metafields`, `created_at`, `updated_at`.
* **Consolidated Response Envelope:**
  Unlike v1, the v2 response embeds user context directly, avoiding multiple round-trips:
  ```json
  {
    "data": [ ... ],
    "relations": { "instructors": [...], "studios": [...], "locations": [...] },
    "booking_cutoff": "2026-10-13T12:00:00.000000Z",
    "extended_cutoff": "2026-10-21T12:00:00.000000Z",
    "booked_events": [],
    "friends_booked": []
  }
  ```

#### Single Event & Floor Plan (v2)
* **Method:** `GET`
* **Path:** `/api/customer/v2/events/{id}`
* **Response Envelope:** Returns event data along with floor plan slots, current bookings, and eligibility:
  * `data`: Event object (`occupancy`, `capacity`, `is_fully_booked`, `status`, etc.).
  * `slots`: Array of physical layout slot objects/IDs.
  * `bookings`: Map of current user and friend bookings.
  * `valid_booking_methods`: Available booking methods (`subscriptions`, `credits`, `preferred_booking_method`).
  * `is_bookable_standard` & `is_bookable_extended`: Booleans indicating current user booking window eligibility.
  * `relations`: Full relation maps for instructors, event types, studios, locations, plans, and credit types.

### 2.2 Authenticated Endpoints (Auth Required)

#### User Profile
Retrieves user contact details, metadata fields, and booking cutoffs.
* **Method:** `GET`
* **Path:** `/api/v1/customer/profile`
* **Key Fields:**
  * `booking_cutoff`: ISO date representing the standard booking window threshold.
  * `extended_cutoff`: ISO date representing the extended booking window threshold.
  * `metafields.extended_booking_allowed`: Boolean indicating if the user has advanced booking privileges.

#### User Credits
Lists the user's active, unused class credits.
* **Method:** `GET`
* **Path:** `/api/v1/customer/credits`
* **Params:** `page=1`, `type=unused`, `per_page=999` (Filtering `type=unused` is strictly required to prevent fetching a massive payload of expired history).

#### Active Bookings
Lists user's active, upcoming class bookings.
* **Method:** `GET`
* **Path:** `/api/v1/customer/bookings`
* **Params:** `limit=100`, `page=1`

#### Past Bookings (v2, live-verified 2026-10-05)
* **Method/Path:** `GET https://psycle.codexfit.com/api/customer/v2/bookings?filter[type]=past&page[size]=100&page[number]=P` (also `filter[type]=cancelled`; allowed filters are only `event.id`, `customer.id`, `type`; no `include`s).
* **Envelope:** `{data, links, meta, message, relations:{events, instructors, event_types, studios, locations}}`; page by `meta.last_page` (the `links` repeat `page[number]`). Page size 100 works, 500 gives a 504.
* **Depth:** complete (857 rows back to 2016 on the measured account). Rows carry no attended/no-show flag and no cancelled rows appear in `past`.

#### Milestones / Attendance Totals (v2, live-verified 2026-10-05)
* **Method/Path:** `GET https://psycle.codexfit.com/api/customer/v2/milestones`
* **Response:** `{overview:{this_week,this_month,this_year}, kinds:[{kind:"attended_events", kind_label, current_count, milestones:[{id, slug, name, description, threshold, window_days, bundle_handle, reward_summary, badge_label, card_width, color, current_count, earned, reached_at}]}]}`. `current_count` is the official attended total (excludes no-shows); it matches the profile's `stats.total_unique_bookings_attended` (770).

#### Active Waitlists
Lists user's active waitlist entries.
* **Method:** `GET`
* **Path:** `/api/v1/customer/waitlists`
* **Params:** `page=1`

#### Book a Class
Books a specific slot in an event.
* **Method:** `POST`
* **Path:** `/api/v1/customer/bookings`
* **Body:**
  ```json
  {
    "event_id": 205627,
    "slots": [17]
  }
  ```
* **Response:** `{ "success": true, "bookings": { "8255409": 17 } }` (The keys in `bookings` represent booking IDs, and values represent slot IDs).

#### Cancel a Booking
Cancels a booking. Penalty-free if done >12 hours before class start (or within the 1-minute grace window).
* **Method:** `DELETE`
* **Path:** `/api/v1/customer/bookings/{booking_id}`

#### Join a Waitlist
Joins the waitlist for a full class.
* **Method:** `PUT` (corrected 2026-09-26 — a live capture confirmed `PUT`, not `POST`; the app's code was
  already right, only this doc was wrong. See `server/fixtures/codexfit-v2/PARITY.md` gate G2.)
* **Path:** `/api/v1/customer/waitlists/{event_id}`
* **Response:** `{success: true, waitlist: {id, customer_id, event_id, added_at, event: {...full event...}}}`
  — `waitlist.id` is the row id, and it is NOT the same as `event_id` (see Leave below).

#### Leave a Waitlist
Leaves a waitlist. Always penalty-free.
* **Method:** `DELETE`
* **Path:** `/api/v1/customer/waitlists/{waitlist_id}` — **corrected 2026-09-26**: this is the WAITLIST ROW
  id (`waitlist.id` from the join response, or from `GET /waitlists`), **not** the event id. A live capture
  confirmed the real site calls `DELETE /waitlists/{row id}`, never `DELETE /waitlists/{event id}` — an
  event can be waitlisted by many customers, each with their own row id. This doc previously showed
  `{event_id}` here, and the app's code made the same mistake (fixed in `providers/codexfit.js
  leaveWaitlist()`, C2-2). See `server/fixtures/codexfit-v2/waitlist-v1-join-leave.json` and PARITY.md
  gate G2.

---

### 2.3 Bookmark/Favorite Endpoints

Users can bookmark class slots to easily configure Auto-Book. Bookmarks are stored in the user profile under `metafields.public.bookmarks.events`.

#### Add a Bookmark
* **Method:** `PUT`
* **Path:** `/api/v1/customer/profile/metafields/bookmarks.events.{identifier}`
* **Body:** `{"data": "{identifier}"}`

#### Remove a Bookmark
* **Method:** `DELETE`
* **Path:** `/api/v1/customer/profile/metafields/bookmarks.events.{identifier}`

#### Bookmark Identifier Formula
Identifiers target recurring slots by compounding the studio, day of the week, and time:
```
[studio_id] + "0000" + [day_of_week] + "0000" + [HHmm]
```
* **`studio_id`**: Studio room ID (e.g. `108`).
* **`day_of_week`**: Day integer (`0` for Sunday, `1` for Monday, etc.).
* **`HHmm`**: 24-hour start time (e.g. `1930` for 7:30 PM).

Example: Studio 138, Monday at 19:30 → `1380000100001930`

---

### 2.4 Heartbeat & Cache Invalidation

The native CodexFit Vue app implements a cache invalidation mechanism via the `/heartbeat` endpoint:
* **Method:** `GET`
* **Path:** `/api/v1/customer/heartbeat`

The response yields UTC timestamps for each data type (e.g., `events`, `instructors`, `bookings`). The client compares these timestamps against local storage to determine if cached data needs to be re-fetched.


---

### 2.5 Cart & Checkout API (v2)

In September 2026, CodexFit transitioned to a RESTful v2 Cart & Checkout API (`/api/customer/v2`). This replaces the legacy query-parameter-based v1 endpoints (`/cart/add_bundle/...` and `/cart/ajaxCheckoutProcess`).

* **Base URL:** `https://psycle.codexfit.com/api/customer/v2`
* **Authentication:** `Authorization: Bearer <JWT>` (obtained from login or cookie `codex_bearer_token`).
* **Required Headers:**
  * `Accept: application/json`
  * `Content-Type: application/json`
  * `Origin: https://psyclelondon.com`
  * `Referer: https://psyclelondon.com/`

#### 2.5.1 Cart Session & Client Storage
* **LocalStorage Key:** `psycle-codex-cart` (CodexFit prefixes the key with `app_id` `psycle-`, storing `{ "uuid": "...", "expires_at": ... }`).
* **UI Drawer Event:** The website cart drawer modal is triggered via:
  ```javascript
  document.dispatchEvent(new CustomEvent('codex.modal.open.codex-cart', { bubbles: true }));
  // Or clicking the DOM trigger:
  document.querySelector('[data-codex-modal-toggle="codex-cart"]')?.click();
  ```
* **Client Networking Architecture:** The native CodexFit bundle buying frontend uses **Axios**, which operates via `XMLHttpRequest` (not `window.fetch`). Browser extension interceptors modifying outgoing bundle requests must hook `XMLHttpRequest.prototype.send` to inspect and rewrite the request payload.

#### 2.5.2 Cart Lifecycle Endpoints

##### 1. Initialize Cart Session
Creates a new cart session if one does not already exist.
* **Method:** `POST`
* **Path:** `/api/customer/v2/cart`
* **Body:** `{}`
* **Response — corrected 2026-09-26** (a live capture, `server/fixtures/codexfit-v2/cart-v2-lifecycle.json`,
  contradicted the shape previously shown here): a freshly-initialized, never-touched cart has **no
  `stripe` key in `metadata` at all** — not even a zero-amount one. `metadata` is just `{"organisation":
  null}` until a line is added. See gate G3 in `server/fixtures/codexfit-v2/PARITY.md`.
  ```json
  {
    "data": {
      "uuid": "cf7c552a-3e5a-4de5-9632-f110678fff12",
      "currency": "GBP",
      "subtotal": 0,
      "total": 0,
      "lines": [],
      "metadata": { "organisation": null }
    }
  }
  ```

##### 2. Get Cart Snapshot
Retrieves the cart state, line items, taxes, and Stripe PaymentIntent details.
* **Method:** `GET`
* **Path:** `/api/customer/v2/cart/{uuid}`
* **Key Fields:**
  * `lines`: Array of line items currently in the cart.
  * `metadata.stripe`: present only once the cart has (or has had) a chargeable line — **confirmed live,
    2026-09-26**: a `PaymentIntent` (`type: "payment"`) while the cart holds a chargeable line, a
    zero-amount `SetupIntent` (`type: "setup"`, `amount: 0`) once it's been emptied again, and **absent
    entirely** on a cart that's never had a line at all (see #1 above). `metadata.stripe.secret` is the
    client secret for in-app or client-side confirmation either way.

##### 3. Add Item to Cart
Adds a package bundle or product to the cart session.
* **Method:** `POST`
* **Path:** `/api/customer/v2/cart/{uuid}/lines`
* **Body — corrected 2026-09-26**: a live capture showed **no `quantity` field at all** in the real
  request; the server defaults new lines to quantity 1. Reaching a higher quantity goes through the
  separate increment/decrement mutation endpoint (#4 below), not a `quantity` value on add. See gate G3 in
  `server/fixtures/codexfit-v2/PARITY.md`.
  ```json
  {
    "type": "bundle",
    "id": 792
  }
  ```
* **Response:** Returns the new line item. Each line item contains a unique `hash` (MD5 hex string, e.g.
  `"889e8bcafbb1b6f0b01dd6395db573b6"`) used for subsequent mutations.

##### 4. Mutate Item Quantity (Increment / Decrement)
Modifies the quantity of an existing line item.
* **Method:** `PUT`
* **Path:** `/api/customer/v2/cart/{uuid}/lines/{hash}`
* **Body:**
  ```json
  {
    "hash": "889e8bcafbb1b6f0b01dd6395db573b6",
    "action": "increment"
  }
  ```
  *(Use `"action": "decrement"` to decrease quantity)*.

##### 5. Remove Item from Cart
Completely deletes a line item from the cart.
* **Method:** `DELETE`
* **Path:** `/api/customer/v2/cart/{uuid}/lines/{hash}`

##### 6. Apply / Remove Voucher
* **Apply Method:** `POST`
* **Apply Path:** `/api/customer/v2/cart/{uuid}/vouchers`
* **Apply Body:** `{"code": "SUMMER10"}`
* **Remove Method:** `DELETE`
* **Remove Path:** `/api/customer/v2/cart/{uuid}/vouchers/{voucherCode}`

#### 2.5.3 Payment & Checkout Flow

##### 1. List Saved Payment Methods
Retrieves customer's saved payment methods stored on Stripe.
* **Method:** `GET`
* **Path:** `/api/customer/v2/payment-methods`
* **Response:** Array of payment methods with `id` (`pm_...`), `brand` (`amex`, `visa`), `last4`, and `exp_year`.

##### 2. Attach Payment Method to Cart
* **Method:** `POST`
* **Path:** `/api/customer/v2/cart/{uuid}/payment-method`
* **Body:**
  ```json
  {
    "payment_method": "pm_1Hxxxxxxxxxxxxxxxxxxxx"
  }
  ```

##### 3. Begin Checkout
Transitions the cart session to checkout state.
* **Method:** `POST`
* **Path:** `/api/customer/v2/cart/{uuid}/checkout`
* **Body:** `{}`

##### 4. Finalise Order
Submits the order for asynchronous processing and payment capture.
* **Method:** `POST`
* **Path:** `/api/customer/v2/cart/{uuid}/finalise`
* **Body:**
  ```json
  {
    "analytics": {
      "user_agent": "...",
      "screen_resolution": "1920x1080"
    }
  }
  ```
* **Response:** Returns HTTP `202 Accepted` during asynchronous creation. The client polls the status endpoint using exponential backoff until the order status resolves to `succeeded` or `paid`.

---

### 2.6 Retired / Obsolete Endpoints (v1 Cart)

> [!WARNING]
> The following v1 endpoints have been retired by CodexFit and should no longer be called in new integrations:
> * `POST /api/v1/customer/cart/add_bundle/{bundleId}?instance={instance}` ➔ **RETIRED** (Replaced by `POST /api/customer/v2/cart/{uuid}/lines`).
> * `GET /api/v1/customer/cart/get_payment_methods?instance={instance}` ➔ **RETIRED** (Replaced by `GET /api/customer/v2/payment-methods`).
> * `POST /api/v1/customer/cart/set_payment_method/{pmId}` ➔ **RETIRED** (Replaced by `POST /api/customer/v2/cart/{uuid}/payment-method`).
> * `POST /api/v1/customer/cart/ajaxCheckoutProcess` ➔ **RETIRED** (Replaced by `POST /api/customer/v2/cart/{uuid}/finalise`).
> * The `instance` query parameter pattern is obsolete; carts are identified exclusively by UUID in the RESTful v2 path hierarchy `/cart/{uuid}/...`.

---

## 3. Web timetable rendering & Caching

### 3.1 Client Architecture & Bootstrapping
The Shopify storefront embeds CodexFit via `https://psycle.codexfit.com/bootstrap.js`, which dynamically mounts and injects the production bundle:
* **Default Script:** `https://codexfit-api-assets.s3.amazonaws.com/production/latest/main.js` (Last-Modified: Sept 2026).
* **Retired Script:** `https://api-v2.codexfit.com/latest/app.js` (legacy May 2026 bundle).
* **Script Override Hook:** `bootstrap.js` inspects `localStorage.getItem("codex-script-override")` and `window.CODEX_SCRIPT_OVERRIDE`. It exposes developer controls on `window.codexBootstrap.setOverride(url)` and `clearOverride()`.

**Component & Stage Hierarchy:**
```
codex-main-app (root Vue instance)
├── timetable (Vue component — manages events, filters, carousel)
│   ├── timetable-filter (instructor, workout type dropdowns)
│   ├── VueSlickCarousel (date navigation carousel)
│   └── VueSlickCarousel (events carousel showing classes)
└── event (Vue component — booking modal and floor plan)
```

### 3.2 Relation Resolution (`Xi` & `Qs` helpers)
The API returns a flat array of events and a `relations` dictionary of studios, locations, instructors, credit types, and event types. In the modern client (`main.js`), the relation linker traverses all `*_id` properties (e.g. `instructor_id`, `studio_id`) and attaches the corresponding resolved object from `relations` (e.g. `event.instructor`, `event.studio`). Template rendering across the timetable and booking modals relies on these nested relational objects.

### 3.3 Incremental Loading
To keep payloads manageable, the native timetable loads 10 days of schedule at first. As the user slides the carousel, it incrementally requests additional ranges up to a maximum of 42 days.

**Correction (2026-09-26, `server/fixtures/codexfit-v2/PARITY.md` gate G4):** a live capture showed the
initial load actually fires **three separate single-day `/events` calls** (today + 2 more days), not one
wider-ranged request — see §2.1.1 above. Further-day loading via the date carousel was **not confirmed**
in that session: the visible carousel did not respond to synthetic clicks or drag/swipe gestures across
many attempts, and scrolling to the page bottom triggered no new `/events` call. The real trigger for
loading additional days is unidentified; this section's "up to 42 days" claim is unverified beyond the
first 3 days.

### 3.4 Location ID Mapping
The timetable location is derived from the page URL and sent as a `preFilter` to the API:
* Oxford Circus = `1`
* Shoreditch = `2`
* Clapham = `3`
* Notting Hill = `4`
* Victoria = `5`
* Bank = `6`
* London Bridge = `7`

---

## 4. Spot Swapping Limitations

### 4.1 Missing Controller Methods
Probing the CodexFit Laravel backend reveals that `OPTIONS /api/v1/customer/bookings/{id}` lists `GET`, `PUT`, and `PATCH` as supported verbs. However, authenticated API testing shows that invoking any of these verbs yields an HTTP 500 error:
```
BadMethodCallException: Method App\Http\Controllers\Api\Customer\BookingController::show does not exist
```
The routes exist as boilerplate generated by Laravel's resource routing (`Route::resource`), but the underlying controller only implements `index` (list), `store` (create), and `destroy` (cancel). 

### 4.2 Architectural Impact
Because there is no atomic spot-swap or spot-update API, changing a spot (manually or via Auto-Upgrade) requires a **cancel-then-rebook** flow:
1. `DELETE /bookings/{bookingId}` to release the current spot.
2. `POST /bookings` with the new target slot ID.

This introduces a brief race window where the original spot is gone, but the new spot might fail to book (taken by another user, network error, or credit failure). Within 12 hours of the class start, the cancellation also forfeits the credit unless special parameters are read by the server (unverified).


## Timezone

CodexFit `start_at` is timezone-NAIVE local time and the API publishes no zone anywhere. The zone comes from `gyms.config.js` (`timezone`, optional `locationTimezones`); the adapter emits an offset-bearing ISO and `timeZone` (see `server/providers/timezone.js`).
