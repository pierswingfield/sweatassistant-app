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
* **Path:** `/api/v1/customer/bundles`

---

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
* **Method:** `POST`
* **Path:** `/api/v1/customer/waitlists/{event_id}`

#### Leave a Waitlist
Leaves a waitlist. Always penalty-free.
* **Method:** `DELETE`
* **Path:** `/api/v1/customer/waitlists/{event_id}`

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

## 3. Web timetable rendering & Caching

### 3.1 Vue App Architecture
The timetable page is a Shopify storefront embedding a minified CodexFit Vue.js client (`api-v2.codexfit.com/latest/app.js`).

**Vue Component Hierarchy:**
```
codex-main-app (root Vue instance)
├── timetable (Vue component — manages events, filters, carousel)
│   ├── timetable-filter (instructor, workout type dropdowns)
│   ├── VueSlickCarousel (date navigation carousel)
│   └── VueSlickCarousel (events carousel showing classes)
└── event (Vue component — booking modal and floor plan)
```

### 3.2 Relation Resolution (`Qs` helper)
The API returns a flat array of events and a `relations` dictionary of studios, locations, instructors, and event types. On receipt, the Vue app invokes `Qs(events, relations)` to dynamically replace ID fields on events with their full relational objects (e.g., `event.instructor_id` becomes `event.instructor` containing name, photo, and keyword metafields). This resolution is crucial because template rendering relies on object sub-properties.

### 3.3 Incremental Loading
To keep payloads manageable, the native timetable loads 10 days of schedule at first. As the user slides the carousel, it incrementally requests additional ranges up to a maximum of 42 days.

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
