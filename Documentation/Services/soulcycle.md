# SoulCycle — Platform & Integration Architecture Documentation

This document serves as the technical reference for SoulCycle's booking platform (`soul-cycle.com`), evaluated via live session inspection (Chrome remote debugging port 9222) and JavaScript source analysis on 2026-09-29.

---

## 1. Executive Summary & Platform Classification

Unlike **Psycle** (which uses CodexFit) or **JAB Boxing** (which uses Mariana Tek), **SoulCycle does NOT use a commercial third-party fitness SaaS platform**. 

Instead, SoulCycle operates a **custom, proprietary in-house platform**:
* **Backend:** Monolithic PHP application (classic PHP session handling, `SOULSESSION` cookie, `session_cache_limiter('nocache')` emitting `Expires: Thu, 19 Nov 1981 08:52:00 GMT`, and internal server identifiers like `prod-web-05`).
* **Frontend:** Hybrid server-rendered HTML pages, Next.js / React micro-frontends, and jQuery-driven booking widgets.
* **Edge & Infrastructure:** AWS (EC2/ECS) behind Envoy proxy gateways (`server: istio-envoy`), CloudFront CDN (`*.cloudfront.net`), and S3 asset storage (`soul-cdn.com`).
* **APIs:** No public or documented third-party REST/GraphQL API. Interactions occur via form submissions, embedded page state (`__APP_STATE__`), and AJAX endpoints.

---

## 2. Authentication & Session Architecture

### 2.1 Session Storage & Cookies
SoulCycle uses traditional stateful cookie-based sessions:
* `SOULSESSION` — The primary session cookie (`HttpOnly; Secure; SameSite=Lax`). Corresponds directly to PHP's `PHPSESSID`.
* `region` — Stored cookie tracking current region (e.g., `{"id":26}` for London).
* `user` — Client-accessible cookie tracking logged-in state.

### 2.2 Direct Login Flow
Unauthenticated users submit credentials via a standard POST form:
```http
POST https://www.soul-cycle.com/login/
Content-Type: application/x-www-form-urlencoded
Origin: https://www.soul-cycle.com
Referer: https://www.soul-cycle.com/signin/

email=user%40example.com&password=secretpassword&csrf_token=6abbdce30455e
```
* **CSRF Token:** Required on login. Extracted from `<input type="hidden" name="csrf_token" id="frm-csrf_token">` on `GET https://www.soul-cycle.com/signin/`.
* **Success:** 302 redirect back to the account profile or target booking page with `Set-Cookie: SOULSESSION=...`.
* **Failure:** 200 OK rendering the signin page with error banners.

### 2.3 One-Time CSRF Nonce Pool
SoulCycle uses a client-side "nonce pool" for in-page AJAX actions (reserving bikes, joining waitlists, unreserving classes):
* Injected into the page script:
  ```javascript
  window.soulcycle.noncePool = [
    "6abbdbab043d1",
    "6abbdbab043d4",
    "6abbdbab043d5",
    ...
  ];
  ```
* Every mutating AJAX request pops a nonce (`csrf_token: window.soulcycle.noncePool.pop()`).
* For programmatic automation, a client must either scrape an unused nonce from the DOM or fetch an endpoint that replenishes nonces.

---

## 3. Data Structures & State Model

### 3.1 Global Application State (`window.__APP_STATE__`)
Server-rendered pages embed bootstrap data in a script tag:
```javascript
window.__APP_STATE__ = Object.assign({}, JSON.parse(decodeURIComponent('%7B...%7D')));
```

Key sub-objects include:

#### Rider Object
```json
{
  "id": 2409564,
  "first_name": "Piers",
  "last_name": "Wingfield",
  "email": "soulcycle@piersj.com",
  "region": 26,
  "phone_number": "+447414608391",
  "joined": "2018-12-03 11:48:53",
  "bike_bar_height": "5.5",
  "bike_handlebar_depth": -4,
  "bike_seat_height": "6.0",
  "bike_seat_distance": "0.0",
  "shoe_size": 44,
  "adyen_payment_profile_id": "SB2RLVB3JC4CH9X3"
}
```

#### Rider Series (Credits) Object
SoulCycle calls class credits **"Series"**:
```json
{
  "rider_id": 2409564,
  "region_id": 26,
  "total_credits": 0,
  "usable_credits": 0,
  "base_credits": 0,
  "transferable_credits": 0,
  "has_unlimited": false,
  "series": []
}
```

#### Studio & Region Hierarchy
```json
{
  "United Kingdom": {
    "26": {
      "id": 26,
      "title": "London",
      "sort_order": 220,
      "studios": [
        {
          "id": 1103,
          "title": "Soho London"
        }
      ]
    }
  }
}
```

---

## 4. Timetable & Schedule Discovery

Unlike modern JSON-first APIs, SoulCycle does not expose a clean public timetable endpoint on the web.

### 4.1 Studio Schedule Pages
Schedules are server-rendered at studio URLs (e.g. `https://www.soul-cycle.com/studios/uk-london/`).
Each class is represented in the DOM as an upcoming class row:
```html
<div class="upcoming-class session open class_info_row"
     data-class-id="2411610"
     data-class-datetime="2026-09-30 07:00:00"
     data-capacity="0">
    <div class="class_info">
        <a href="/find-a-class/select-bike/2411610/" class="book_btn">Reserve</a>
    </div>
</div>
```

*An automated adapter must parse this HTML structure (e.g. using `cheerio`) or discover the internal JSON endpoints used by their mobile app (iOS App ID: 966733747).*

---

## 5. Seat Maps & Live Availability

### 5.1 Bike Layout
The bike layout page is located at `https://www.soul-cycle.com/find-a-class/select-bike/<class_id>/`.
Seats are laid out using grid coordinates:
```html
<div class="seat open" 
     data-id="309893" 
     data-value="48" 
     data-x="16" 
     data-y="6" 
     style="left: 94.5%; top: 31.5%;">
    <span class="seat_number">48</span>
</div>
```
* `data-id`: The internal seat ID (e.g., `309893`).
* `data-value`: The human-visible bike number (e.g., `48`).
* `data-x`, `data-y`: Studio layout coordinates.

### 5.2 Real-Time Availability Polling
The web client polls seat availability every 2,500ms via AJAX:
```http
GET https://www.soul-cycle.com/find-a-class/poll-availability/?class=2411610
Accept: application/json, text/javascript, */*; q=0.01
X-Requested-With: XMLHttpRequest
Cookie: SOULSESSION=...
```

**Response (200 OK):**
```json
{
  "success": true,
  "message": null,
  "reservations": {
    "309831": "taken",
    "309837": "taken",
    "309841": "taken",
    "reservation_info": {
      "booked_count": 40
    }
  }
}
```

---

## 6. Booking, Waitlists & Cancellations

All mutating actions use AJAX POST requests with CSRF nonces.

### 6.1 Reserve a Bike
```http
POST https://www.soul-cycle.com/find-a-class/reserve-bike/
Content-Type: application/x-www-form-urlencoded; charset=UTF-8
X-Requested-With: XMLHttpRequest
Cookie: SOULSESSION=...

seat_id=309893&class_id=2411610&csrf_token=6abbdbab043d1
```

**Response Scenarios (JSON):**
* `code: "success"` / `code: "booked"`: Booking confirmed. Returns `message` and `_links` (schedule, bookmarks).
* `code: "taken"`: Seat already taken.
* `code: "insufficientseries"`: Rider has no credits remaining.
* `code: "noseat"`: Backend disputes the existence of that seat/room combo.
* `code: "insertfailure"`: Database record insert failed on backend.

### 6.2 Join Waitlist
```http
POST https://www.soul-cycle.com/find-a-class/join-waitlist/
Content-Type: application/x-www-form-urlencoded
X-Requested-With: XMLHttpRequest
Cookie: SOULSESSION=...

class_id=2411610&csrf_token=...
```

### 6.3 Cancel / Unreserve Class
```http
POST https://www.soul-cycle.com/profile/unreserve-class/
Content-Type: application/x-www-form-urlencoded
X-Requested-With: XMLHttpRequest
Cookie: SOULSESSION=...

reservation_id=123456&csrf_token=...
```
*Note: Policy check enforced: cancellations are rejected after 5 PM on the day prior or within the late-cancel window.*

---

## 7. Integration Feasibility Assessment

| Component | Assessment | Implementation Notes |
|:---|:---|:---|
| **Architecture Feasibility** | **Feasible** | Custom `SoulCycleProvider` implementing `GymProvider`. |
| **Effort** | **Medium–High** | Higher friction than CodexFit or Mariana Tek due to non-REST web architecture. |
| **Authentication** | Stateful Cookie Jar | Requires persisting `SOULSESSION` cookie; relogin requires scraping login CSRF token and `POST /login/`. |
| **Timetable Ingestion** | HTML Scraping | Requires parsing server-rendered studio HTML via `cheerio` (or proxying iOS app private API if sniffed). |
| **Seat Map Normalization** | High Parity | Clean 2D coordinates (`data-x`, `data-y`) and seat IDs map directly into Sweat Assistant's `makeSlot()` schema. |
| **Auto-Book / Precision Engine** | Supported | Direct `POST /find-a-class/reserve-bike/` with target `seat_id` and pre-fetched `csrf_token`. |
| **Edge / WAF Protection** | CloudFront / Envoy | Requests must include realistic User-Agent, Referer, and Origin headers to avoid CDN challenges. |
