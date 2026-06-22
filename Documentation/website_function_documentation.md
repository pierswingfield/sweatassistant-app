# Psycle London Website — Timetable Function Documentation

> **Purpose**: This document describes how the native Psycle London website (`psyclelondon.com`) processes and renders timetable data from the CodexFit API. It is intended to guide extension augmentation (auto-book buttons, new-tab booking, caching).

---

## 1. Architecture Overview

The timetable page is a **Shopify-hosted page** (`/pages/{location}-timetable`) that embeds a **CodexFit Vue.js application** (`app.js` from `api-v2.codexfit.com`). The Vue app mounts into a `<div id="codex-main-app">` container and renders the entire timetable UI client-side.

### Component Hierarchy

```
codex-main-app (root Vue instance)
├── timetable (Vue component — manages events, filters, carousel)
│   ├── timetable-filter × 2 (instructor, event_type_group dropdowns)
│   ├── VueSlickCarousel (date navigation — calendar carousel)
│   └── VueSlickCarousel (events carousel — day-by-day class list)
│       └── [event-container divs] (rendered per class via v-for)
└── event (Vue component — booking modal / class detail view)
```

### Key Scripts

| Script | Source | Role |
|--------|--------|------|
| `app.js` | `api-v2.codexfit.com/latest/app.js` | CodexFit Vue app (minified) — all timetable logic |
| `addons.js` | `api-v2.codexfit.com/clients/psycle/addons.js` | Psycle-specific customisations |
| `vue.js` | `cdn.jsdelivr.net/npm/vue/dist/vue.js` | Vue 2 runtime |
| `slick.js` | `cdnjs.cloudflare.com/ajax/libs/slick-carousel/1.9.0/slick.js` | Carousel library |
| `app.min.js` | `psyclelondon.com/cdn/shop/.../assets/app.min.js` | Shopify theme JS |
| `merged.min.js` | `psyclelondon.com/cdn/shop/.../assets/merged.min.js` | Theme utilities |

### CodexFit Configuration (`window.codex`)

The page initialises `window.codex` with:

```javascript
window.codex = {
  api: 'https://psycle.codexfit.com',
  components: {},
  stageIds: ['codex-main-app', 'nathan', 'codex-cart-app', 'codex-nav-app', ...],
  locale: 'en-GB',
  currency: 'GBP',
  app_id: 'psycle',
  // ...styling, chat, settings
}
```

Each `stageId` corresponds to a Vue mount point. The timetable lives in `codex-main-app`.

---

## 2. API Endpoints & Data Flow

### 2.1 Initial Page Load

When the timetable page loads, the Vue app makes **three parallel API calls**:

| # | Endpoint | Params | Purpose |
|---|----------|--------|---------|
| 1 | `GET /api/v1/customer/events` | `location=1&start=2026-06-14 00:00:00&end=2026-06-27 00:00:00` | Fetches events for the location and date range |
| 2 | `GET /api/v1/customer/instructors` | — | Instructor metadata (names, photos, bios) |
| 3 | `GET /api/v1/customer/event-type-groups` | — | Workout type groups (Ride, Barre, Strength, etc.) |

All three are **public** (no auth required). The `location` param is a numeric ID derived from the page URL (e.g., Oxford Circus = `1`).

### 2.2 Events Response Structure

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
      "credit_types": [{"credit_type": 1}, ...],
      "accepted_plans": [{"plan_id": 4}, ...],
      "accepted_credits": [{"credit_type_id": 1}, ...],
      "max_bookable_slots": 4,
      "is_visible": true,
      "is_waitlistable": true,
      "is_always_bookable": false,
      "is_live_stream": false,
      "is_fully_booked": false,
      "status": "finished",
      "occupancy": 31,
      "capacity": 35,
      "tags": [],
      "all_tags": ["Ride", "new-coach"]
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

**Critical**: The `relations` object in the response contains the lookup tables for `studios`, `locations`, `event_types`, and `instructors`. The Vue app calls a function `Qs(events, relations)` to **resolve IDs to full objects** on each event, so after resolution `event.instructor` is a full object (not just an ID).

### 2.3 Relation Resolution (`Qs` function)

The minified `Qs(events, relations)` function iterates over each event and replaces foreign-key IDs with their corresponding objects from the `relations` map:

- `event.instructor_id` → `event.instructor` (full instructor object with `first_name`, `full_name`, `photo`, `metafields`)
- `event.studio_id` → `event.studio` (full studio object with `name`, `location`, `layout`)
- `event.event_type_id` → `event.event_type` (full event type with `name`, `handle`, `group`, `metafields`)

This resolution happens **immediately after the API response** and is essential — the template references `event.instructor.first_name`, `event.studio.name`, `event.event_type.name`, etc.

### 2.4 Lazy Loading / Pagination

The timetable uses **incremental loading**:

- **Initial load**: Fetches `daysToShow` (3) + `daysToPreload` (7) = ~10 days of events
- **On carousel slide**: When the user scrolls near the end of loaded data, `onSlideChange` / `beforeCarousel` triggers `loadEvents()` again
- **`loadEvents()`** calculates the next date range and appends new events to `this.events`
- **Maximum**: Loading stops after `eventDaysLoaded` reaches 42 days
- **`preFilter`**: Always includes `location` (from page context) and `start`/`end` date range

```javascript
// Simplified loadEvents logic:
loadEvents() {
  this.loading = true;
  const startDate = moment().max(moment(), this.startDate ? moment(this.startDate) : moment()).startOf('day');
  const start = moment(startDate).add(this.eventDaysLoaded, 'days').format('YYYY-MM-DD HH:mm:ss');
  const end = moment(startDate).add(this.eventDaysLoaded + 2*this.daysToShow + this.daysToPreload, 'days').format('YYYY-MM-DD HH:mm:ss');
  const params = Object.assign(this.preFilter, {start, end});
  
  api.get('events', params).then(response => {
    this.events = this.events.concat(response.data.data);
    this.relations = response.data.relations;
    Qs(this.events, this.relations); // Resolve IDs → objects
    this.loading = false;
    this.eventDaysLoaded += 2*this.daysToShow + this.daysToPreload;
  });
}
```

### 2.5 Event Detail (Booking Modal)

When a user clicks "Book class" or "Join waitlist", the `gotoEvent(event, true)` method is called:

```javascript
gotoEvent(event, openModal) {
  if (openModal) {
    // Opens the booking modal in-page
    document.dispatchEvent(new CustomEvent('codex-event-modal', { detail: event.id }));
  } else {
    // Navigates to the class detail page
    window.location.href = this.eventDetailUrl + '/' + event.id;
    // e.g., /pages/class/205278
  }
}
```

The **modal path** (`openModal = true`) dispatches a `CustomEvent` named `"codex-event-modal"` with the event ID. The `event` component listens for this and calls `showModal(eventId)` → `loadEvent(eventId)`.

The **navigation path** (`openModal = false`) navigates to `/pages/class/{event_id}`.

### 2.6 Event Detail API Call

When the modal opens, `loadEvent(eventId)` fetches full event details:

```
GET https://psycle.codexfit.com/api/v1/customer/events/{event_id}
```

This returns:
- Full event data (same as timetable but for a single event)
- `slots` array (available slot IDs for the floor plan)
- `bookings` (user's existing bookings for this event, if authenticated)
- `valid_credits` (credits the user can use)
- `valid_subscriptions` (subscriptions that cover this event)
- `max_bookable_slots`
- `is_bookable_standard` / `is_bookable_extended` (booking window flags)

### 2.7 Booking API Call

```javascript
// POST /api/v1/customer/bookings
api.post('bookings', { event_id: this.event.id, slots: this.slotsSelected })
```

Where `slots` is either an array of selected slot IDs (for studios with floor plans) or a count (for studios without layouts).

---

## 3. Rendering Pipeline

### 3.1 Data → View Flow

```
API Response (events + relations)
    ↓
Qs(events, relations)  — resolve IDs to objects
    ↓
this.events = events.concat(newEvents)
    ↓
computed: groupedEvents  — groups events by date (start_at.split('T')[0])
    ↓
computed: groupedEventsIndex  — maps dates to slide indices
    ↓
VueSlickCarousel renders day columns
    ↓
Each day column: v-for event in groupedEvents[date]
    ↓
isVisible(event) filters by: time (am/pm), elapsed, studio, location, event_type, event_type_group, instructor
    ↓
Each event renders: .event-container > .event-inner
    ├── .event-details (time, name, instructor, studio)
    ├── .event-controls-a (favourite heart, "more info" toggle)
    └── .event-controls-b ("Book class" or "Join waitlist" button)
```

### 3.2 CSS Classes for Event States

| Class | Condition |
|-------|-----------|
| `.inactive` | `customer && !isBookable(event)` — class is outside booking window |
| `.logged-out` | `!customer` — user not logged in |
| `.full-no-waitlist` | `event.is_fully_booked && !event.is_waitlistable` — completely full |
| `.isFavourited` | `isBookmarked('events', generateBookmarkIdentifier(event))` — user has favourited |

### 3.3 Booking Window Logic (`isBookable`)

```javascript
isBookable(event) {
  const startAt = moment(event.start_at);
  
  // Not logged in: only show future events
  if (!this.customer) return !startAt.isBefore(moment());
  
  // Past bookable_until time
  if (event.bookable_until) {
    if (moment(event.bookable_until).isBefore(moment())) return false;
  } else if (moment(event.start_at).isBefore(moment())) {
    return false;
  }
  
  // Check booking cutoff
  return event.is_always_bookable
    || startAt.isBefore(moment(this.customer.booking_cutoff))
    || startAt.isBefore(moment(this.customer.extended_cutoff));
}
```

**Booking Window Details:**

The website uses a **rolling Monday 12:00 PM release system**. Classes become bookable in weekly waves:

| Window | Cutoff | Who Can Book |
|--------|--------|-------------|
| Standard | `customer.booking_cutoff` | All authenticated users |
| Extended | `customer.extended_cutoff` | Users with `metafields.extended_booking_allowed = true` |
| Always | N/A | Classes flagged `is_always_bookable` (bypass all cutoffs) |

**Standard booking window**: Classes are released every Monday at 12:00 PM London time. The `booking_cutoff` date is typically ~8 days from the release Monday (covers through the following Monday).

**Extended booking window**: Users with the `extended_booking_allowed` metafield get an `extended_cutoff` date approximately **+7 days** beyond the standard cutoff (covers through ~2 weeks from the release Monday).

**How the website disables booking**: When `isBookable(event)` returns `false`, the `.event-inner` element gets the `.inactive` CSS class:
```css
.event-inner.inactive { opacity: 0.5; pointer-events: none; }
```
This grays out the entire event card and prevents clicks.

**Extension's interpretation** (`content.js`):
- `getBookingOffset()`: Returns 8 (standard), 15 (+advanced), or 22 (+advanced+credit) days
- `getBookingCutoffDate()`: Uses `userProfile.booking_cutoff` or `userProfile.extended_cutoff` from the API, with fallback calculation
- `getClassReleaseTime()`: Calculates the exact Monday 12:00 PM when a class becomes bookable
- Settings toggles: `advancedBooking` (+7 days), `advancedBookingCredit` (+7 more days)

**API fields** (from `GET /api/v1/customer/profile`):
- `booking_cutoff`: ISO 8601 date string (e.g., `"2026-06-22T23:59:59"`)
- `extended_cutoff`: ISO 8601 date string (e.g., `"2026-06-29T23:59:59"`)
- `metafields.extended_booking_allowed`: boolean flag

**API fields** (from `GET /api/v1/customer/events/{id}`):
- `is_bookable_standard`: Whether standard booking window is open
- `is_bookable_extended`: Whether extended booking window is open
- `is_always_bookable`: Class bypasses all booking window checks

### 3.4 Bookmark Identifier Generation

```javascript
generateBookmarkIdentifier(event) {
  const t = moment(event.start_at);
  return event.studio.id + "0000" + t.format("d0000HHmm");
  // e.g., studio_id=108, Monday 19:30 → "1080000100001930"
}
```

This creates a stable identifier based on studio + day-of-week + time, resilient to instructor/class name changes.

---

## 4. DOM Structure

### 4.1 Timetable Page Container

```html
<div id="codex-main-app" class="section-page-timetable-layout">
  <!-- Vue renders here -->
</div>
```

### 4.2 Event Card HTML Structure

```html
<div class="event-container" v-on:click="isBookable(event) || !customer ? null : setStorage('show_early_bird_message', true)">
  <div class="event-inner [inactive|logged-out|full-no-waitlist]">
    <div class="event-details">
      <p>
        <span class="time">6:30 am - </span>
        <span class="event-name">RIDE: Signature 45</span>
      </p>
      <p>
        <span class="instructor">Rhys</span>
        <span class="studio-name"> - Ride Studio 1</span>
      </p>
    </div>
    <div class="event-controls-a">
      <a href="#" class="favourite [isFavourited]" @click.stop.prevent="toggleBookmark(...)"></a>
      <a href="#" class="more-info j-info" @click.stop.prevent="$set(event, 'is_expanded', !...)">more info</a>
    </div>
    <div class="event-controls-b">
      <a v-if="event.is_fully_booked && event.is_waitlistable" @click="gotoEvent(event, true)" class="waitlist j-event-waitlist">Join waitlist</a>
      <a v-if="!event.is_fully_booked" @click="gotoEvent(event, true)" class="book j-event-book">Book class</a>
    </div>
  </div>
  <!-- Expanded info modal (toggled by "more info") -->
  <transition name="slide">
    <div class="event-info-modal" v-if="event.is_expanded">
      <a href="#" class="close-icon" @click.stop.prevent="..."></a>
      <div class="content-wrapper">
        <div>
          <p class="tags">{{ event.instructor.metafields.keywords }}</p>
          <p>{{ event.event_type.metafields.description }}</p>
        </div>
        <div class="img-wrap">
          <img :src="event.instructor.photo" alt="instructor name">
        </div>
      </div>
      <a v-if="!event.is_fully_booked" @click="gotoEvent(event, true)" class="btn dark">book class</a>
      <a v-if="event.is_fully_booked && event.is_waitlistable" @click="gotoEvent(event, true)" class="btn dark">join waitlist</a>
    </div>
  </transition>
</div>
```

### 4.3 Booking Modal (Event Component)

The `event` component renders as a modal overlay when `isModal=true` and `visible=true`. It shows:
- Instructor photo and name
- Class type, studio, location, date/time
- Available spaces count
- Credits required / valid credits / valid subscriptions
- Floor plan slot layout (if `hasLayout`)
- "Book class" / "Join waitlist" button
- Booking confirmation with cancel timer

---

## 5. Filter System

### 5.1 Available Filters

The timetable page shows three filters (configured via `showFilters` prop):

| Filter | API Endpoint | Name Key | Multi-select |
|--------|-------------|----------|-------------|
| Instructor | `/api/v1/customer/instructors` | `first_name` | Yes |
| Workout Type | `/api/v1/customer/event-type-groups` | `name` | Yes |
| Location | Hardcoded links to `/pages/{location}-timetable` | — | No (page-level) |

### 5.2 Filter Logic (`isVisible`)

```javascript
isVisible(event) {
  let visible = true;
  
  // Time filter (am/pm)
  if (this.filterTime === 'am' && moment(event.start_at).format('HHmm') >= 1200) return false;
  if (this.filterTime === 'pm' && moment(event.start_at).format('HHmm') < 1200) return false;
  
  // Hide elapsed events
  if (!this.showElapsedEvents) {
    if (event.bookable_until && moment(event.bookable_until).isBefore(moment())) return false;
    else if (moment(event.start_at).isBefore(moment())) return false;
  }
  
  // Studio filter
  if (this.filters.studio && event.studio.id != this.filters.studio) visible = false;
  
  // Location filter
  if (this.filters.location && event.studio.location.id != this.filters.location) visible = false;
  
  // Event type filter
  if (this.filters.event_type && event.event_type.id != this.filters.event_type) visible = false;
  
  // Event type group filter (supports multi-select array)
  if (this.filters.event_type_group) {
    if (Array.isArray(this.filters.event_type_group)) {
      if (!this.filters.event_type_group.includes(event.event_type.group.id.toString())) visible = false;
    } else if (event.event_type.group.id != this.filters.event_type_group) visible = false;
  }
  
  // Instructor filter (supports multi-select array)
  if (this.filters.instructor) {
    if (Array.isArray(this.filters.instructor)) {
      if (!this.filters.instructor.includes(event.instructor.id.toString())) visible = false;
    } else if (event.instructor.id != this.filters.instructor) visible = false;
  }
  
  return visible;
}
```

### 5.3 Bookmark Filter

When `onlyBookmarks` is enabled (via the "Show favourite classes" toggle), events are additionally filtered by:

```javascript
isBookmarked('events', generateBookmarkIdentifier(event))
```

Bookmarks are stored in the user's profile via `localStorage` and the CodexFit profile metafields API.

---

## 6. Key Findings for Extension Augmentation

### 6.1 Adding Auto-Book Buttons to Native Timetable

**Approach**: Use a `MutationObserver` or `setInterval` to inject auto-book buttons into each `.event-container` element after the Vue app renders them.

**Target elements**:
- `.event-controls-b` — the container for "Book class" / "Join waitlist" buttons
- Each `.event-container` has access to the Vue event data via the Vue component's scope

**Getting event data from Vue**: The Vue component's data is reactive and not directly accessible from outside. Options:
1. **Intercept the API response** (already done by the extension's `interceptor.js`) and maintain a parallel events array
2. **Access the Vue instance**: `window.codex.stages['codex-main-app'].$children[0]` (the timetable component) — `.$data.events` contains all loaded events
3. **Parse the DOM**: Extract event ID from the rendered HTML (not directly available as a data attribute, but the "Book class" button's click handler dispatches `codex-event-modal` with the event ID)

**Recommended approach**: Access the Vue instance's events array to get event data, then inject buttons that reference the extension's auto-book logic.

### 6.2 Opening Class Detail in a New Tab

**Current behaviour**: Clicking "Book class" calls `gotoEvent(event, true)` which dispatches `document.dispatchEvent(new CustomEvent('codex-event-modal', { detail: event.id }))`. This opens an in-page modal.

**Alternative navigation**: `gotoEvent(event, false)` navigates to `/pages/class/{event_id}` in the current tab.

**To open in a new tab**: Intercept the click on `.j-event-book` and `.j-event-waitlist` links, prevent default, and open `https://psyclelondon.com/pages/class/{event_id}` in a new tab.

**Challenge**: The event ID is not directly available as a DOM data attribute. It's only in the Vue component's scope. Options:
1. **Override `gotoEvent`**: Monkey-patch the Vue method to use `window.open()` instead of `document.dispatchEvent()`
2. **Add click listeners**: Add click listeners to `.j-event-book` and `.j-event-waitlist` elements that extract the event ID from the Vue component
3. **Intercept the `codex-event-modal` event**: Add a listener for the custom event and redirect to a new tab

**Recommended approach**: Intercept the `codex-event-modal` custom event on `document`, extract the event ID from `event.detail`, and open `/pages/class/{event_id}` in a new tab.

### 6.3 Caching Timetable Data

**Current behaviour**: Every page load triggers fresh API calls for events, instructors, and event-type-groups. No client-side caching exists.

**Caching opportunities**:
1. **Instructors**: Rarely change. Cache in `chrome.storage.local` with a TTL of 24 hours.
2. **Event-type-groups**: Rarely change. Cache similarly.
3. **Events**: Change frequently (occupancy, booking status). Cache with a short TTL (5-10 minutes) and use `If-Modified-Since` or ETag headers if available.
4. **Event details** (single event): Cache with a short TTL for the floor plan layout, but always refresh slots/availability.

**Implementation**: The extension's `interceptor.js` already intercepts API responses. Extend it to cache responses in `chrome.storage.local` with timestamps, and serve cached data when the page loads while refreshing in the background.

### 6.4 Performance Observations

- The timetable loads **all events for the initial date range** in a single API call (no pagination)
- The `instructors` and `event-type-groups` endpoints return full lists every time
- The Vue app re-fetches all data on every page navigation (no caching)
- The `Qs()` relation resolution runs on every `loadEvents()` call, re-processing all events
- The carousel library (`VueSlickCarousel`) renders all day columns in the DOM, even off-screen ones

---

## 7. API Reference Summary

### Public Endpoints (No Auth)

| Endpoint | Method | Key Params | Returns |
|----------|--------|-----------|---------|
| `/api/v1/customer/events` | GET | `location`, `start`, `end` | Events array + relations |
| `/api/v1/customer/events/{id}` | GET | — | Single event + slots + booking info |
| `/api/v1/customer/instructors` | GET | — | Instructor list |
| `/api/v1/customer/event-type-groups` | GET | — | Workout type groups |
| `/api/v1/customer/locations` | GET | — | Location list |
| `/api/v1/customer/studios` | GET | — | Studio list (with layouts) |
| `/api/v1/customer/heartbeat` | GET | — | Health check |

### Authenticated Endpoints (Bearer JWT Required)

| Endpoint | Method | Key Params | Returns |
|----------|--------|-----------|---------|
| `/api/v1/customer/profile` | GET | — | User profile + booking_cutoff |
| `/api/v1/customer/credits` | GET | `type=unused` | User's unused credits |
| `/api/v1/customer/bookings` | GET | `limit`, `page` | User's active bookings |
| `/api/v1/customer/waitlists` | GET | `page` | User's waitlist entries |
| `/api/v1/customer/bookings` | POST | `{event_id, slots}` | Create a booking |
| `/api/v1/customer/bookings/{id}` | DELETE | — | Cancel a booking |
| `/api/v1/customer/waitlists/{id}` | PUT | — | Join a waitlist |
| `/api/v1/customer/waitlists/{id}` | DELETE | — | Leave a waitlist |

### Common Headers

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

---

## 8. Vue Component Props Reference

### Timetable Component Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `eventDetailUrl` | String | `/pages/class` | URL base for class detail pages |
| `daysToShow` | Number | 7 | Days visible per carousel slide |
| `daysToPreload` | Number | 0 | Extra days to preload |
| `daysToScroll` | Number | 7 | Days to scroll per navigation click |
| `startDate` | String | — | Override start date |
| `showFromStartOfDay` | Boolean | true | Start from current day |
| `showBookmarksOnly` | Boolean | false | Show only bookmarked classes |
| `preFilter` | Object | `{location: 1}` | Default filters (location from page context) |
| `filterKeys` | Array | `["studio","location","event_type","event_type_group","instructor"]` | Available filter dimensions |
| `showFilters` | Array | `["location","event_type_group","instructor"]` | Which filters to display |
| `showDateHeader` | Boolean | true | Show date header |
| `hidePagination` | Boolean | false | Hide prev/next buttons |
| `carouselSettings` | Object | `{arrows: false, dots: false, ...}` | Slick carousel config |
| `showElapsedEvents` | Boolean | false | Show past events |
| `loggedOutVisibility` | Boolean | false | Show events when logged out |

### Event Component Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `id` | Object | — | Event ID (or loaded from URL) |
| `redirectUrl` | String | `/pages/thank-you` | Post-booking redirect |
| `slotSize` | Number | 50 | Floor plan slot pixel size |
| `purchaseUrl` | String | `/pages/buy` | Credit purchase page |
| `videoUrl` | String | `/pages/video` | Live stream page |
| `autoBook` | Boolean | true | Enable single-click booking |
| `isModal` | Boolean | false | Render as modal (true on timetable) |
| `useLoginModal` | Boolean | false | Use login modal for auth |

---

## 9. Custom Events

| Event Name | Detail | Source | Listener | Purpose |
|-----------|--------|--------|----------|---------|
| `codex-event-modal` | `event.id` (number) | Timetable `gotoEvent()` | Event component `showModal()` | Opens booking modal for a class |
| `codex-login-toggle` | — | Event component | Login modal | Opens login dialog |

---

## 10. Location ID Mapping

The timetable page URL determines the `location` filter:

| URL Path | Location ID | Location Name |
|----------|------------|---------------|
| `/pages/oxford-circus-timetable` | 1 | Oxford Circus |
| `/pages/shoreditch-timetable` | 2 | Shoreditch |
| `/pages/clapham-timetable` | 3 | Clapham |
| `/pages/notting-hill-timetable` | 4 | Notting Hill |
| `/pages/victoria-timetable` | 5 | Victoria |
| `/pages/bank-timetable` | 6 | Bank |
| `/pages/london-bridge-timetable` | 7 | London Bridge |

The location ID is passed as a `preFilter` prop to the timetable component, which includes it in all API requests.