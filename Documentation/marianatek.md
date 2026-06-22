# Mariana Tek Platform Research & Multi-Provider Architecture Plan

**Date:** June 22, 2026 (desk research); June 22, 2026 (live API research with JAB Boxing test account)
**Purpose:** Scope what it would take to support gyms/fitness studios that use Mariana Tek as their technology provider, alongside the existing CodexFit integration (Psycle London).

> **Live research performed:** Sections 1A–1F document findings from live API testing against `jabboxingclub.marianatek.com` using an authorized test account. The desk research sections (2–15) follow and are annotated where live findings supersede them.

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
1A. [Live Research Findings — JAB Boxing (jabboxingclub)](#1a-live-research-findings--jab-boxing-jabboxingclub)
1B. [Confirmed Auth Flow](#1b-confirmed-auth-flow)
1C. [Confirmed Endpoint Map](#1c-confirmed-endpoint-map)
1D. [Confirmed Data Schemas](#1d-confirmed-data-schemas)
1E. [JAB Boxing Specifics](#1e-jab-boxing-specifics)
1F. [Remaining Unknowns After Live Research](#1f-remaining-unknowns-after-live-research)
2. [Platform Overview](#2-platform-overview)
3. [API Surface](#3-api-surface)
4. [Auth Model — The Critical Difference](#4-auth-model--the-critical-difference)
5. [Booking Model](#5-booking-model)
6. [Feature Gap Analysis vs CodexFit](#6-feature-gap-analysis-vs-codexfit)
7. [Community Knowledge & Reverse Engineering](#7-community-knowledge--reverse-engineering)
8. [Gaps & Unknowns](#8-gaps--unknowns)
9. [Multi-Provider Architecture Plan](#9-multi-provider-architecture-plan)
10. [Database Schema Changes](#10-database-schema-changes)
11. [Per-Component Impact Analysis](#11-per-component-impact-analysis)
12. [Features That May Not Port](#12-features-that-may-not-port)
13. [Level of Effort Summary](#13-level-of-effort-summary)
14. [Key Architectural Risks](#14-key-architectural-risks)
15. [Research Plan (Authorized Follow-Up)](#15-research-plan-authorized-follow-up)

---

## 1. Executive Summary

Mariana Tek is a boutique-fitness business management platform (SaaS) owned by **Xplor Technologies**, used by brands like Barry's, Barre3, SpinCo, Pvolve, and Modo Yoga. Unlike CodexFit (which has no official public API and was reverse-engineered), Mariana Tek has a **comprehensive, officially documented REST API** with OAuth2 auth, webhooks, an OpenAPI 3.0.3 schema (83 endpoints), and a developer partner program.

**Live research (June 22, 2026) confirmed the critical auth question:** The password grant (`grant_type=password`) is **NOT supported** by the web integrations OAuth client. However, a **headless OAuth flow** (CSRF login → authorize → token exchange) works programmatically — the server can authenticate as the member with just email+password, without browser interaction. The resulting access token lasts **7 days** (604800 seconds) and the **refresh token works and is not rotated**. This means the server-BFF model is viable: store credentials encrypted, perform headless OAuth on login, refresh tokens every 7 days autonomously.

**Overall effort estimate: L (5–8 weeks)** — reduced from XL because the auth model is now confirmed and the endpoint shapes are mapped. The provider abstraction layer (Phase 1) remains the highest-risk work because CodexFit logic is interleaved with business logic across 5 server files.

---

## 1A. Live Research Findings — JAB Boxing (jabboxingclub)

**Tenant:** `jabboxingclub` (subdomain: `jabboxingclub.marianatek.com`)
**Test account:** aiproscw@gmail.com (Sebastian Clearwater, user id=60623)
**Date:** June 22, 2026

### What was tested

| Test | Result |
|------|--------|
| Public API (no auth) | ✅ `/classes`, `/locations`, `/config`, `/theme`, `/regions`, `/schedule_filters` all return data |
| OpenAPI schema download | ✅ 83 endpoints, 302KB YAML from `docs.marianatek.com/api/customer/v1/schema/` |
| OAuth client_id discovery | ✅ `sbLziNCoF5HcOhkSV6zRL8O7betwd3mDDIQbWZa3` (shared across all MT tenants, extracted from web integrations OAuth redirect) |
| Password grant (`grant_type=password`) | ❌ `unauthorized_client` — this client_id is PKCE-only |
| Headless OAuth flow (CSRF login → authorize → token) | ✅ Works programmatically with `requests` library + cookie jar |
| Token exchange (authorization_code + PKCE) | ✅ Returns `access_token` (7-day expiry) + `refresh_token` |
| Refresh token flow | ✅ New access token obtained, refresh token NOT rotated, 7-day expiry |
| `GET /me/account` | ✅ User profile (id, name, email, phone, home_location, waiver status) |
| `GET /me/credits` | ✅ Returns credit packages (0 for test account) |
| `GET /me/reservations` | ✅ Returns upcoming reservations with spot details |
| `GET /me/reservations/{id}/cancel_penalty` | ✅ Returns `{is_penalty_cancel, message}` — read-only, safe |
| `POST /me/reservations` (create booking) | ✅ Endpoint works — error "The payments do not satisfy the cost of this reservation" (no credits) |
| `POST /me/reservations/{id}/swap_spots` | ✅ **Confirmed working** — swapped spot 24 → spot 8 → back to 24. This is the auto-upgrade mechanism. |
| `GET /classes/{id}` (with layout) | ✅ Returns 40 Pick-A-Spot spots with x/y positions, is_available, spot_type |
| `GET /locations/{id}/buy-page` | ✅ Returns empty (JAB is membership-based, not credit-based) |
| `GET /me/memberships` | ✅ Returns 0 (test account has no membership) |
| `GET /me/credit_cards` | ✅ Returns 0 cards |
| `GET /me/orders` | ✅ Returns 0 orders |
| `GET /legal` | ✅ Returns waiver/marketing consent text |
| `POST /me/reservations/{id}/cancel` | ⚠️ NOT tested — user warned not to cancel (credit not returned) |
| `POST /me/reservations/{id}/assign_to_spot` | ⚠️ NOT tested — no waitlisted reservation available |
| Cart endpoints (`/me/reservations/{id}/cart`) | ⚠️ Returns "Authentication credentials were not provided" — may need session auth |

---

## 1B. Confirmed Auth Flow

### The headless OAuth flow (server-side, no browser needed)

```
Step 1: Generate PKCE pair
  code_verifier = random 32-byte base64url string
  code_challenge = SHA256(code_verifier) as base64url

Step 2: GET /o/authorize/ → redirects to /auth/login/
  Params: client_id, scope, response_type=code, redirect_uri, code_challenge, code_challenge_method=S256
  Captures: CSRF token (from HTML form), session cookie

Step 3: POST /auth/login/ with credentials
  Body: csrfmiddlewaretoken, username (email), password, next (the authorize URL)
  Headers: Referer (the login page URL)
  Result: 302 redirect chain → /o/authorize/ → redirect_uri?code=AUTH_CODE

Step 4: POST /o/token/ (exchange code for tokens)
  Body: grant_type=authorization_code, code, client_id, redirect_uri, code_verifier
  Result: { access_token, expires_in: 604800, token_type: "Bearer", scope, refresh_token }

Step 5 (autonomous refresh): POST /o/token/
  Body: grant_type=refresh_token, refresh_token, client_id
  Result: { access_token, expires_in: 604800, refresh_token (same, not rotated) }
```

### Key auth facts

| Property | Value |
|----------|-------|
| **client_id** | `sbLziNCoF5HcOhkSV6zRL8O7betwd3mDDIQbWZa3` (shared across ALL MT tenants) |
| **redirect_uri** | `https://{tenant}.marianaiframes.com/iframe/callback/` |
| **scope** | `read:account` (sufficient for ALL operations including write — booking, swap_spots) |
| **access_token expiry** | 7 days (604800 seconds) |
| **refresh_token rotation** | No — same refresh token reused |
| **password grant** | ❌ Not supported by this client_id (`unauthorized_client`) |
| **client_credentials grant** | ❌ Not supported (`unauthorized_client`) |
| **authorization_code + PKCE** | ✅ The only supported flow |

### Architecture implication

The server-BFF model is viable but slightly more complex than CodexFit:
- **CodexFit**: `POST /auth/login {email, password}` → JWT (one step)
- **Mariana Tek**: 4-step headless OAuth flow (CSRF → login → authorize → token exchange)

The server stores encrypted credentials and performs the headless OAuth flow on login. For autonomous refresh, the server uses the refresh token every 7 days. If the refresh token expires (unknown expiry — likely 30-90 days), the server re-runs the headless OAuth flow with stored credentials.

---

## 1C. Confirmed Endpoint Map

### Public endpoints (no auth required)

| Method | Endpoint | Purpose | Confirmed |
|--------|----------|---------|-----------|
| GET | `/classes` | List classes with filters (date range, location, instructor, class_type, classroom, region) | ✅ |
| GET | `/classes/{id}` | Class detail with Pick-A-Spot layout (spots with x/y positions) | ✅ |
| GET | `/locations` | List studio locations | ✅ |
| GET | `/locations/{id}` | Location detail | ✅ |
| GET | `/regions` | List regions | ✅ |
| GET | `/regions/{id}/schedule_filters` | Schedule filters for a region | ✅ |
| GET | `/config` | Brand config (opt-in copy, URLs) | ✅ |
| GET | `/theme` | Theme settings (colors, fonts, booking window visibility) | ✅ |
| GET | `/countries` | Country list | ✅ (schema) |
| GET | `/legal` | Legal/waiver text | ✅ |

### Authenticated endpoints (Bearer token)

| Method | Endpoint | Purpose | Confirmed | Notes |
|--------|----------|---------|-----------|-------|
| GET | `/me/account` | User profile | ✅ | id, name, email, phone, home_location, waiver status |
| POST | `/me/account` | Create account | ✅ (schema) | |
| PATCH | `/me/account` | Update profile | ✅ (schema) | |
| DELETE | `/me/account` | Delete account | ✅ (schema) | Requires `current_password` |
| GET | `/me/credits` | Credit packages | ✅ | `credits_remaining`, `credits_total`, `expiration_datetime` |
| GET | `/me/reservations` | User reservations | ✅ | Filters: `is_upcoming`, `status`, `min_start_date`, `max_start_date` |
| POST | `/me/reservations` | Create booking | ✅ | Payload: `{"class_session": {"id": X}, "reservation_type": "standard"}`. Error if no credits: "The payments do not satisfy the cost of this reservation." |
| GET | `/me/reservations/{id}` | Reservation detail | ✅ (schema) | |
| POST | `/me/reservations/{id}/cancel` | Cancel reservation | ✅ (schema) | NOT live-tested (user warned not to cancel) |
| GET | `/me/reservations/{id}/cancel_penalty` | Check penalty before cancel | ✅ | Returns `{"is_penalty_cancel": false, "message": null}` |
| POST | `/me/reservations/{id}/swap_spots` | Swap to different spot | ✅ | **Auto-upgrade mechanism!** Payload: `{"spot": spot_id}` |
| POST | `/me/reservations/{id}/assign_to_spot` | Move waitlist → spot | ✅ (schema) | NOT live-tested (no waitlist) |
| POST | `/me/reservations/{id}/check_in` | Check in to class | ✅ (schema) | |
| GET | `/me/memberships` | User memberships | ✅ | |
| GET | `/me/credit_cards` | Saved credit cards | ✅ | |
| GET | `/me/orders` | Order history | ✅ | |
| GET | `/locations/{id}/buy-page` | Credit/membership purchase options | ✅ | Empty for JAB (membership-based) |
| GET | `/me/reservations/{id}/cart` | Reservation cart | ⚠️ | Auth error — may need session auth |

### Endpoints from OpenAPI schema (not yet live-tested)

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET POST | `/me/appointments/bookings` | Appointment bookings (1:1 sessions) |
| GET | `/me/appointments/bookings/{id}` | Appointment detail |
| GET POST PATCH DELETE | `/me/credit_cards/{id}` | Credit card CRUD |
| POST | `/me/memberships/{id}/cancel_membership` | Cancel membership |
| GET | `/me/metrics/*` | User metrics (class count, streaks, etc.) |
| POST | `/me/account/redeem_giftcard` | Redeem gift card |
| GET | `/me/account/renewals/failed` | Failed renewal info |
| POST | `/locations/{id}/cart/checkout` | Cart checkout |
| POST | `/locations/{id}/cart/add_product_listing` | Add product to cart |

---

## 1D. Confirmed Data Schemas

### Class (from `GET /classes/{id}`)

```json
{
  "id": "78872",
  "name": "TRAIN - Chest, Back, Arms",
  "start_datetime": "2026-06-26T05:30:00Z",
  "start_date": "2026-06-26",
  "start_time": "05:30:00",
  "booking_start_datetime": "2026-06-16T06:30:00+01:00",
  "layout_format": "pick-a-spot",           // or "first-come-first-serve"
  "capacity": 40,
  "available_spot_count": 15,
  "waitlist_count": null,
  "status": null,
  "is_cancelled": null,
  "is_free_class": false,
  "is_user_reserved": true,
  "is_user_waitlisted": false,
  "is_user_guest_reserved": false,
  "classroom_name": "TRAIN",
  "location": { "id": "48751", "name": "SW1", ... },
  "instructors": [...],
  "class_tags": [...],
  "layout": {
    "id": "...",
    "name": "...",
    "spots": [
      {
        "id": "36295",
        "name": "24",
        "x_position": 12.4,
        "y_position": 0.0,
        "is_available": true,
        "spot_type": { "id": "6563", "is_primary": true, "name": "Ground" }
      }
    ]
  },
  "spot_options": {
    "primary_availability": ...,
    "primary_capacity": ...,
    "secondary_availability": ...,
    "waitlist_availability": ...,
    "waitlist_capacity": ...
  }
}
```

### UserReservation (from `GET /me/reservations`)

```json
{
  "id": "370724",
  "reservation_type": "standard",          // "standard" | "standby" | "waitlist"
  "status": "pending",                      // "pending" | "check in" | "standard cancel" | etc.
  "waitlist_position": null,
  "is_upcoming": true,
  "is_booked_by_me": false,
  "is_booked_for_me": true,
  "is_change_spots_enabled": true,          // Whether swap_spots is allowed
  "are_add_ons_available": false,
  "booked_by": "Piers Wingfield",
  "spot": {
    "id": "36295",
    "name": "24",
    "x_position": 12.4,
    "y_position": 0.0,
    "spot_type": { "id": "6563", "is_primary": true, "name": "Ground" }
  },
  "class_session": { "id": "78872", "name": "TRAIN - Chest, Back, Arms", ... }
}
```

### User (from `GET /me/account`)

```json
{
  "id": "60623",
  "first_name": "Sebastian",
  "last_name": "Clearwater",
  "email": "aiproscw@gmail.com",
  "phone_number": "07886660877",
  "home_location": { "id": "48751", "name": "SW1", "timezone": "Europe/London", ... },
  "is_waiver_signed": true,
  "has_unsigned_waivers": true,
  "completed_class_count": 0,
  "credit_cards": [],
  "stripe_customer_id": null
}
```

### Cancel Penalty (from `GET /me/reservations/{id}/cancel_penalty`)

```json
{
  "is_penalty_cancel": false,
  "message": null
}
```

### Booking creation payload (for `POST /me/reservations`)

```json
{
  "class_session": { "id": 78830 },
  "reservation_type": "standard"
}
```

Error when no credits: `{"non_field_errors": ["The payments do not satisfy the cost of this reservation."]}`

### Spot swap payload (for `POST /me/reservations/{id}/swap_spots`)

```json
{
  "spot": 36279
}
```

Returns the updated UserReservation with the new spot.

---

## 1E. JAB Boxing Specifics

| Property | Value |
|----------|-------|
| **Tenant slug** | `jabboxingclub` |
| **API base URL** | `https://jabboxingclub.marianatek.com/api/customer/v1/` |
| **OAuth base URL** | `https://jabboxingclub.marianatek.com/o/` |
| **Login page** | `https://jabboxingclub.marianatek.com/auth/login/` |
| **Website** | `jabboxing.club` (WordPress + MT web integrations iframes) |
| **Web integrations** | `jabboxingclub.marianaiframes.com` |
| **Locations** | SW1 Victoria (id=48751), EC1 Moorgate (id=48784, opening Autumn 2026) |
| **Region** | Southeast (id=48575) |
| **Timezone** | Europe/London |
| **Currency** | GBP |
| **Payment gateway** | Stripe |
| **Class types** | BOXING, TRAIN, RECOVERY |
| **Layout formats** | Pick-A-Spot (BOXING, TRAIN — 40 spots), First-Come-First-Serve (RECOVERY — 5 spots) |
| **Booking model** | Membership-based (not credit-based). No buy-page products available via API. |
| **Booking windows** | `are_booking_windows_public: true` (from theme config). `booking_start_datetime` on each class (e.g., 7 days before class start). |
| **Primary color** | `#18214D` (dark navy) |
| **Font** | Gothic A1 |

---

## 1F. Remaining Unknowns After Live Research

| Unknown | Priority | How to resolve |
|---------|----------|----------------|
| **Cancel endpoint behavior** | P1 | Need a booking we can afford to cancel (or a class with free cancellation) |
| **Waitlist join + assign_to_spot** | P1 | Need a waitlisted reservation (requires credits to join waitlist) |
| **Refresh token expiry** | P1 | Monitor over time — likely 30-90 days. Test by waiting or asking MT support. |
| **Cart/checkout flow** | P2 | Cart endpoint returned auth error — may need session auth or different scope |
| **Credit purchase API** | P2 | JAB is membership-based with no buy-page. Other MT studios may have buy-page products. |
| **Webhooks** | P2 | Contact `integrations@marianatek.com` to register a webhook URL |
| **Rate limits** | P3 | Not documented. Monitor for 429 responses during auto-book polling. |
| **Mobile app client_id** | P3 | The community CLI found a password-grant client_id — may be the mobile app's. Could simplify auth if discovered. |

---

## 2. Platform Overview

| Attribute | Detail |
|-----------|--------|
| **What it is** | Boutique fitness-specific business management SaaS (scheduling, memberships, payments, marketing, custom-branded mobile apps) |
| **Owner** | Xplor Technologies (merged with Clubessential Holdings, 2026). Backed by Advent International, Battery Ventures, Silver Lake. |
| **Founded** | 2015, by fitness business owners |
| **HQ** | Washington, DC (USA); operations in UK, Canada, Australia |
| **Scale** | Xplor serves 130,000+ businesses in 72+ countries, $47B+ annual payments |
| **Multi-tenant** | Each studio brand is a subdomain: `{brand}.marianatek.com` |

### Notable Customers (publicly confirmed)

Barry's, Bodybar, Barre3, Modo Yoga, Pvolve, SpinCo, Sweat440, Tremble, Neighborhood Barre, B/SPOKE Studios, Pilates House, 405 Yoga OKC, Kommunity Fitness.

### Products / Modules

| Module | Description |
|--------|-------------|
| **Scheduling / Class Management** | Create, schedule, configure classes; Pick-A-Spot (reserved spots) and First-Come-First-Serve layouts |
| **Member App** | Custom-branded iOS/Android app per studio (MT claims 5-star rated) |
| **Biz App** | Staff/instructor management app for day-of operations, roster, waitlist, check-in |
| **Memberships & Credits** | Credit packages, membership contracts, intro offers, guest usage |
| **POS** | Point-of-sale for retail, mat rentals, add-ons; integrates with Stripe |
| **Marketing** | Automated email/SMS, tags, segmentation, landing pages |
| **Appointments** (new, 2026) | Private training / 1:1 sessions |
| **Reporting** | Real-time utilization, revenue, conversion reports |
| **Franchise Management** | Multi-location dashboard, royalty fee disbursement (new 2025) |

*Confidence: High — all from official Mariana Tek / Xplor sources.*

---

## 3. API Surface

Mariana Tek has a **comprehensive, documented REST API** — a stark contrast to CodexFit (no official API, reverse-engineered by sniffing the website).

### Official Documentation URLs

| Resource | URL |
|----------|-----|
| Developer Guides (hub) | https://guides.marianatek.com/ |
| Customer API (latest, Redoc) | https://docs.marianatek.com/api/customer/v1/redoc/ |
| Customer API (deprecated) | https://docs.marianatek.com/docs/customer-api.html |
| Studio API | https://mariana-api-docs.herokuapp.com/studio-api.html |
| Webhooks | https://guides.marianatek.com/webhooks |
| Getting Started | https://guides.marianatek.com/ |
| Credentials / Auth | https://guides.marianatek.com/credentials |
| OAuth Flow | https://guides.marianatek.com/auth |
| External Auth (OIDC SSO) | https://guides.marianatek.com/ext_auth |
| Bypass Bookings | https://guides.marianatek.com/bypass-booking |
| Mariana Anemone (Embedded Apps SDK) | https://guides.marianatek.com/mariana-anemone |
| **OpenAPI 3.0.3 schema** | https://docs.marianatek.com/api/customer/v1/schema/ (81 endpoints, 292KB — confirmed by community) |

### APIs Available

| API | Purpose | Auth Type |
|-----|---------|-----------|
| **Admin API** | Primary control-plane API for backend/business logic | API key (bearer) |
| **Customer API** | Customer-facing: schedule, bookings, account, credits | OAuth2 (bearer) |
| **Studio API** | Manage studio configurations (layouts, classrooms) | API key (bearer) |
| **MT Stripe API** | Custom checkout flows via Stripe | API key |
| **Documents API** | Waivers, contracts, agreements | API key |
| **Pricing API** | Dynamic pricing control | API key |
| **Webhooks** | Event-driven notifications | Callback URL registration |
| **Advertising API** | In-app ad serving | API key |

**Architecture:** REST, HTTPS, JSON (`application/vnd.api+json` for write operations per JSON:API convention). Some endpoints use standard JSON.

**Getting credentials:** Contact `integrations@marianatek.com`. No self-service developer portal found (as of June 2026). Onboarding: contact Integrations → receive sandbox + credentials → build → technical review → go live.

**Rate limits:** Not publicly documented.

*Confidence: High — all from official developer guides.*

---

## 4. Auth Model — The Critical Difference

This is the single most important architectural consideration for the Psycle PWA.

### How CodexFit works today (the enabler)

```
POST /api/v1/customer/auth/login  { email, password }  →  JWT
```

The server-side BFF authenticates as the member directly with stored credentials. No browser redirect. This is what enables:
- Server-side auto-book at Monday noon without the user's device being online
- Server-side auto-upgrade polling 24/7
- Server-side cancellation/booking-window reminders
- Automatic session renewal on 401 (re-login with stored password)

### How Mariana Tek officially works

**OAuth 2.0 Authorization Code flow** (with PKCE for SPAs/mobile):

```
1. Redirect user to: https://{BRAND}.marianatek.com/o/authorize
   ?response_type=code&client_id={CLIENT_ID}&redirect_uri={REDIRECT_URI}&scope=read:account&state={STATE}

2. User logs in at Mariana Tek's Universal Auth page (hosted by MT)

3. Auth code returned to redirect_uri

4. Exchange code for tokens:
   POST https://{BRAND}.marianatek.com/o/token
   { code, grant_type: "authorization_code", client_id, client_secret, redirect_uri }

5. Response: { access_token, expires_in, refresh_token, token_type, scope }
```

**Refresh tokens ARE supported:**
```
POST https://{BRAND}.marianatek.com/o/token/?refresh_token={REFRESH_TOKEN}&grant_type=refresh_token&client_id={CLIENT_ID}&client_secret={CLIENT_SECRET}
```

**External Auth (OIDC SSO):** MT supports OIDC-compliant identity providers configured at the brand level. Flow: User → Studio login page → External IdP → MT `/custom-client-openid-connect/` endpoint → MT session.

**No Shopify Multipass** (unlike CodexFit). MT owns the identity layer.

### The critical unknown: Direct credential login

The official docs do **not** describe a `grant_type=password` flow (the equivalent of CodexFit's direct login). The official pattern is that the app redirects to MT's hosted login page.

**However**, the community CLI `marianatek-pp-cli` implements:
```
marianatek login --tenant <slug> --email --password
```
which performs an **OAuth2 password grant** for headless/CI use. This suggests a password-grant-like flow exists but is **not officially documented**.

*Confidence: Medium for the password-grant existence (community-discovered only).*

### Two scenarios and their implications

#### Scenario A: Password grant works for third-party servers

- **Minimal changes**: New auth adapter calls the password grant endpoint. `refreshAuth()` uses refresh tokens (or re-login with stored credentials).
- **Architecture stays identical to current CodexFit model**: credentials encrypted at rest, server re-authenticates autonomously.
- **Effort: Low** for the auth component.

#### Scenario B: Only OAuth2 Authorization Code works

The PWA must perform the OAuth dance (browser redirect), and the server holds a **refresh token** instead of credentials:

1. User taps "Login with [Studio Brand]" → PWA navigates to MT's authorize page
2. User authenticates in MT's auth page
3. MT redirects to the PWA's callback URL with `?code=...`
4. Server exchanges code for access + refresh tokens, stores them, issues a local PWA JWT
5. Server uses refresh tokens to maintain access autonomously

**What breaks:**
- If the refresh token expires or is revoked, the server **cannot recover** — the user must open the PWA and re-authenticate via browser.
- Auto-book silently fails if the refresh token dies between two Mondays.
- Auto-upgrade polling stops if the token dies.

**Risk depends on MT's refresh token policy:**
- 90 days with sliding expiry → manageable (re-auth once per quarter)
- 30 days → annoying but survivable
- Single-use rotation → higher server complexity (rotation races)

### Recommended auth architecture: Credential Ladder

The server tries methods in priority order:

```
authenticate() ladder:
1. Use accessToken if not expired              ← cached, no API call
2. Exchange refreshToken for new accessToken    ← OAuth2 refresh
3. Re-login with stored encryptedPassword       ← password grant (if available)
4. Push-notify user: "Please re-login"          ← human intervention needed
```

For OAuth-only: the server holds the refresh token and refreshes independently. User re-auth is only needed when the refresh token itself expires.

---

## 5. Booking Model

### Class / Session Representation

A bookable class is a **class session**. The Admin API `class_sessions` endpoint retrieves the schedule (filters: date range, location, classroom, class type, instructor, class tags). The Customer API exposes a `classes` endpoint (public reads, no auth) that returns class sessions with **`booking_start_datetime`** — the critical field for auto-book timing.

### Layouts — Spot/Floor Plan Support

**Yes — first-class Pick-A-Spot support** (equivalent to Psycle's bike floor plans):

- Layouts: **First-Come-First-Serve (FCFS)** or **Pick-A-Spot**
- Pick-A-Spot layouts contain discrete `spots` with `x_position`, `y_position`, `name`, `is_secondary`, `is_default_held`
- Capacity: max 100 spots (Pick-A-Spot), max 1000 (FCFS)
- Spots can be `is_default_held` (held by studio, not bookable unless released)
- Layouts associated with a `classroom`

*Source: Studio API docs (official). Confidence: High.*

### Booking Windows

Two types:
1. **Interval Windows** — fixed release times (e.g., "Every Monday at 9 AM, release classes for the following week")
2. **Rolling Windows** — continuously evaluated (e.g., "30 days from now")

Configurable per credit/membership type. VIP credits can have extended windows. Per-class overrides possible.

**`booking_start_datetime`** on each class session = when the window opens (equivalent of CodexFit's `booking_cutoff` / release time).

*Source: https://support.marianatek.com/en/articles/1983326*

### Waitlists

**Full waitlist support with native auto-fill + SMS:**
- Customers join waitlist when class is full
- **Waitlist Auto-Fill Window** determines when auto-promotion stops
- When a spot opens, waitlisted customers receive **SMS notification** with booking link (first-come, first-served)
- Auto-fill runs until **Reservation Cutoff Window** (e.g., 5 min before class)
- `reservation_type: "waitlist"` in the bypass booking API

*Source: https://support.marianatek.com/en/articles/2548120 + /articles/11646988. Confidence: High.*

### Cancellation / Penalties

- Late cancellation windows configurable per membership/credit type
- Penalty fees for no-shows / late cancellations (automatic processing)
- `reservation_type` values: `standard`, `standby`, `waitlist`
- `status` values: `pending`, `check in`, `standard cancel`, `penalty cancel`, `graced cancel`, `penalty no show`, `graced no show`, `removed`, `class cancelled`, `penalty removed`

### Capacity / Occupancy

- Capacity set on layout (max 100 Pick-A-Spot, max 1000 FCFS)
- Class sessions have `available_spot_count` and `waitlist_count` fields
- Studios can set booking limits per customer or per credit/membership type

---

## 6. Feature Gap Analysis vs CodexFit

| Psycle PWA Feature | Mariana Tek Capability | Confidence | Notes |
|-------------------|----------------------|------------|-------|
| **Timetable fetch + filtering** | ✅ Supported | High | Customer API `classes` endpoint (public, no auth). Filters: date range, location, classroom, class_session_type, employee, class_tags. Also Admin API `class_sessions`. |
| **Quick-book (one-click with saved preferences)** | ⚠️ Partially supported | Medium | Booking supported via Customer API (`me/reservations`) or Admin API (bypass booking). But "one-click with saved spot preferences" is a Psycle-specific concept — no native "preferred spots" in MT. |
| **Auto-book (precision-scheduled booking at release time)** | ⚠️ Theoretically supported, not built-in | Medium | MT exposes `booking_start_datetime` per class — a server could poll until that time and POST a reservation. No native "scheduled auto-book queue." Bypass Bookings API can create guest reservations at any time. Precision-scheduling logic must be built by Psycle. |
| **Auto-upgrade (polling for better spots when waitlisted)** | ⚠️ Partially supported | Medium | Waitlist exists and auto-fills via SMS. API exposes `available_spot_count` and `waitlist_count`. But no API to "watch for upgrade opportunity" — MT handles promotions automatically. A third-party app must poll to detect waitlist position changes or spot openings. Community CLI notes "the API exposes no waitlist signal" — had to poll. |
| **Waitlist join/leave** | ✅ Supported | High | `reservation_type: "waitlist"` in bypass booking API. Customer API likely supports this too. Auto-fill is built-in. |
| **Buy credits / bundles** | ⚠️ Not directly accessible | Medium | MT's commerce/checkout flows are via Web Integrations or native app. No documented Customer API endpoint to *purchase* credits — only to *view* balance and make reservations. Buying likely redirects to Web Integration checkout. |
| **Bookmarks / favourites** | ❓ Unknown | Low | No mention of a bookmark/favourites API in public Customer API docs. Would need investigation. |
| **Push notifications** | ⚠️ Built-in, but not accessible to third-party apps | Medium | MT sends push via its own native app infrastructure. No documented Customer API to *send* push. No Web Push / VAPID for third-party developers. Psycle's VAPID push still works for its own notifications, but only if the server has an active MT access token. |
| **Spot map / floor plan with preferred slots** | ✅ Supported | High | Studio API provides Pick-A-Spot layouts with x/y positions per spot. Customer API class detail shows floor plan for booking. Storing *preferred* spot maps server-side and using them for auto-booking priority is NOT built-in — must be built by Psycle. |

### Summary Comparison

| Dimension | CodexFit | Mariana Tek |
|-----------|----------|-------------|
| **API availability** | Unofficial / reverse-engineered | Official (with developer program) |
| **Public docs quality** | None (community-maintained) | Comprehensive developer guides |
| **Auth for third-party server** | ✅ Direct login POST | ❓ Unclear (OAuth redirect required; password grant unconfirmed) |
| **Class schedule API** | ✅ (reverse-engineered) | ✅ (official) |
| **Spot selection (Pick-A-Spot)** | ✅ | ✅ (first-class, Studio API) |
| **Booking windows** | Rolling Monday noon | Configurable interval or rolling |
| **Waitlist + auto-fill** | ❌ Not native | ✅ Native with SMS |
| **Webhooks** | ❌ | ✅ (documented) |
| **Credit purchase API** | ✅ (cart API) | ❓ Not documented |
| **Push notifications** | ❌ | ✅ (native app only) |
| **OpenAPI spec** | ❌ | ✅ (81 endpoints) |
| **Multi-tenant** | Single studio | First-class (subdomains) |
| **Community tooling** | Minimal | Rich (`marianatek-pp-cli`, Ruby gem) |

**Bottom line:** Mariana Tek is far more developer-friendly than CodexFit. However, the auth model (OAuth2 with browser-based login) is not a direct fit for the "server pre-authenticates as member" pattern. The critical unknown is whether a server-side credential grant exists and works for third-party integration.

---

## 7. Community Knowledge & Reverse Engineering

### Community Repositories

#### 1. `Bitlancer/mariana_api-gem` (Ruby, 7 stars, last updated 2020)
Ruby client for the Mariana Tek Admin API. Demonstrates OAuth2 Authorization Code flow, token refresh, API key usage. Likely outdated.

#### 2. `mvanhorn/printing-press-library` — `marianatek-pp-cli` (Go, active May 2026)
**The most comprehensive community-developed MT integration.** Key findings:
- **Spec source:** Official OpenAPI 3.0.3 at `docs.marianatek.com/api/customer/v1/schema/` (81 endpoints, 292KB)
- **OAuth2 password grant:** CLI supports `marianatek login --tenant <slug> --email --password` for headless/CI use — bypasses browser-based OAuth flow
- **Endpoints discovered:**
  - `me/reservations` — user's reservations
  - `me/appointments-bookings-create` — book an appointment
  - `me/appointments-bookings-list` — list appointments
  - `me/reservations-assign-to-spot-create` — move waitlist/standby to a spot
  - `me/reservations-cancel-create` — cancel reservation
  - `classes` (public, no auth) — class listing with `booking_start_datetime`
  - `locations`, `regions` (public)
- **Cancellation watching:** "the API exposes no waitlist signal" — had to implement polling to detect spot openings
- **Multi-tenant:** Each tenant is a subdomain; auth is per-tenant
- **Scorecard:** 89/100 against the OpenAPI spec, 95% verify pass rate

#### 3. `Mariana-Tek/mariana-anemone` (JavaScript, 10 stars, official)
MT's own Embedded Apps SDK for apps that load inside the MT Admin Application. Not relevant for customer-facing integrations.

#### 4. `Mariana-Tek/express-mariana-integrations-demo` (official, 0 stars)
Demo app for Web Integrations V3 — how to embed MT widgets in a studio website.

#### 5. `Mariana-Tek/mariana-auth-demo` (official, 2 stars)
Official demo of Universal Authentication flow.

### Key Community Discoveries

| Discovery | Source | Official? |
|-----------|--------|-----------|
| OAuth2 password-grant-like flow exists for headless login | `marianatek-pp-cli` source | ❌ No — reverse-engineered |
| `/api/customer/v1/classes` works without auth, returns `booking_start_datetime` | Community (multiple) | ⚠️ Undocumented but widely observed |
| `me/reservations-assign-to-spot-create` to move waitlisted user to a spot | `marianatek-pp-cli` | ❌ Not in official docs |
| `me/appointments-bookings-create` for booking appointments | `marianatek-pp-cli` | ❌ Not in official docs |
| OpenAPI 3.0.3 schema at `docs.marianatek.com/api/customer/v1/schema/` | `marianatek-pp-cli` readme | ✅ Official (referenced as spec source) |
| `available_spot_count` and `waitlist_count` on class sessions | Community | ✅ Official |

---

## 8. Gaps & Unknowns

The following could NOT be determined from public sources and require authorized investigation:

### Authentication Gaps
1. **Direct email/password credential grant** — Whether a third-party server can authenticate as a member with just email+password (without browser redirect). The single most critical unknown.
2. **Token lifetime** — How long OAuth access tokens remain valid; whether refresh tokens can be stored long-term for server-side scheduled booking.
3. **Ephemeral tokens** — Customer API docs mention `X-Ephemeral-Token` on account creation, but no general "login with credentials" API is documented.

### Booking API Gaps
4. **Exact reservation creation endpoint shape** — Bypass Bookings docs show `POST /api/reservations` (JSON:API body). Customer API's member booking endpoint shape not fully documented. Community has implemented it — needs verification.
5. **Spot selection in booking** — Can the API specify a preferred spot ID, or is spot selection interactive only?
6. **Spot locking / hold during booking flow** — Can spots be temporarily held (race condition handling)?
7. **Per-class booking window override** — Can the API return the effective booking window per user (accounting for membership type)?
8. **Booking idempotency** — How are duplicate booking attempts handled?

### Commercial / Credits Gaps
9. **Credit package purchase API** — Can a third-party app initiate a credit purchase, or only via Web Integration checkout?
10. **Membership / plan enumeration** — Can the API return available credit packages and memberships for purchase?

### User Preferences / Data Gaps
11. **Bookmarks / Favourites** — Is there an API to read/write favourite classes or instructors?
12. **Notification preferences** — Can users configure which notifications they receive via the API?
13. **Studio preferences (spot maps)** — No documented API for storing user-specific preferred spots per studio (the Psycle `studio_preferences` concept is Psycle-specific).

### Platform / Infrastructure Gaps
14. **Rate limits** — Not documented.
15. **Webhook event catalog** — Complete list of event types not publicly documented.
16. **Push notification infrastructure** — No server-push or Web Push API for third-party notifications.
17. **Calendar / .ics export** — No mention of iCal export in public API docs.

---

## 9. Multi-Provider Architecture Plan

### Current State: No Abstraction Boundary

CodexFit-specific logic is interleaved with business logic across **5 server files**:

| File | CodexFit coupling |
|------|------------------|
| `auth.js` L23 | Hardcoded URL `https://psycle.codexfit.com/api/v1/customer/auth/login` |
| `auth.js` L26-30 | CodexFit-specific headers (`origin`, `referer`, `x-organisation`) |
| `server.js` L434 | Hardcoded base URL in `proxyRequest()` |
| `server.js` L504-633 | Entire cart/checkout system is CodexFit-specific |
| `scheduler.js` L61-73 | Duplicate `getCodexFitHeaders()` (copy-pasted verbatim into poller.js) |
| `scheduler.js` L31-58 | `getBookingOffset()` / `getClassReleaseTime()` — Monday-noon rolling logic |
| `poller.js` L9-21 | Duplicate `getCodexFitHeaders()` |
| `poller.js` L292-308 | `normalizeBooking()` parses CodexFit-specific response shape |
| `client/lib.js` L5-33 | `getClassReleaseTime()` — duplicate of server scheduler logic |

The `getCodexFitHeaders()` helper is **copy-pasted verbatim** between `scheduler.js` and `poller.js`. The `fetchCodexFit()` 401-retry wrapper is also duplicated. This is the strongest signal that an abstraction is overdue.

### Proposed: ProviderAdapter Interface

Each provider implements a single module:

```javascript
// server/providers/interface.js — contract

// Authentication
authenticate(credentials: {email, password}) → { accessToken, refreshToken?, expiresAt, user }
refreshAuth(storedState: {refreshToken?}) → { accessToken, expiresAt }
getAuthHeaders(accessToken): { [header: string]: string }
getBaseURL(): string

// Timetable
fetchEvents(params: {start, end, location?}) → { events[], relations }
fetchEventDetail(eventId) → { event, slots[], bookings[] }

// Booking lifecycle
bookSlots(eventId, slotIds: number[]) → { bookingId, slotIds }
cancelBooking(bookingId) → void
joinWaitlist(eventId) → void
leaveWaitlist(waitlistId) → void

// User data
fetchProfile() → { id, credits, bookingCutoff?, extendedCutoff?, metafields }
fetchBookings() → booking[]
fetchCredits() → credit[]
fetchBundles() → bundle[]  // optional — null if unsupported

// Cart (optional — null if unsupported)
addBundleToCart(bundleId, instanceId?) → cart
checkoutCart(instanceId, paymentMethodId) → order

// Release timing
getReleaseTime(event, userSettings?) → DateTime (London)
getNextReleaseWindow() → DateTime

// Normalization
normalizeEvent(raw) → StandardEvent
normalizeBooking(raw) → StandardBooking
normalizeSlot(raw) → { id, x, y, label, status }
getSlotLayout(eventDetail) → { slots[] }

// Bookmarking (optional — null if unsupported)
getBookmarkIdentifier(event) → string | null
toggleBookmark(identifier) → void
```

### New Files

| File | Purpose | ~Lines |
|------|---------|--------|
| `server/providers/interface.js` | Provider adapter contract + shared `authenticatedFetch()` helper | ~80 |
| `server/providers/codexfit.js` | CodexFit adapter (extracted from auth.js, scheduler.js, poller.js, server.js) | ~400 |
| `server/providers/marianatek.js` | Mariana Tek adapter | ~500 |
| `server/providers/mock.js` | Mock provider adapter (extracted from existing `mock.js`, made conformant) | ~200 |

### Refactoring per file

**`auth.js`** → thin orchestrator:
- `handleLogin(email, password, provider)` delegates to `providers[provider].authenticate()`
- `triggerAutoRelogin(userId)` → credential ladder (refresh token → password re-login → notify user)
- New: OAuth callback handler (`GET /api/auth/oauth/callback`)
- New: Provider registry (`getProvider(name)`)

**`server.js`**:
- `proxyRequest()` → `adapter.getBaseURL() + pathName`, headers from `adapter.getAuthHeaders()`
- Cart routes → provider-gated (return 400 if unsupported)
- SSE route → unchanged (provider-agnostic)

**`scheduler.js`**:
- `getClassReleaseTime()` → `adapter.getReleaseTime(event, settings)` (MT adapter returns `event.booking_start_datetime` directly — simpler)
- `getCodexFitHeaders()` / `fetchCodexFit()` → deleted; shared helper in `providers/interface.js`
- All hardcoded URLs → adapter method calls
- `resolveLiveMap()` → unchanged (provider-agnostic)
- Booking dispatch → `adapter.bookSlots()`, waitlist fallback → `adapter.joinWaitlist()`

**`poller.js`**: Same treatment as scheduler. `normalizeBooking()` → adapter method.

**`client/src/api.js`**:
- `api.login()` accepts optional `provider` param
- New: `api.loginOAuth(provider, tenantSlug)` — initiates OAuth redirect
- Proxy methods → unchanged (server routes through correct adapter)
- Cart methods → client checks `settings.provider` before showing cart UI

**`client/src/lib.js`**:
- `getClassReleaseTime()` becomes CodexFit-specific. Preferred: server includes `releaseTime` in normalized event payload, eliminating client-side release-time math entirely.

---

## 10. Database Schema Changes

### `users` table — add 5 columns

```sql
ALTER TABLE users ADD COLUMN provider TEXT NOT NULL DEFAULT 'codexfit';
ALTER TABLE users ADD COLUMN tenant_slug TEXT;
ALTER TABLE users ADD COLUMN access_token TEXT;        -- rename from 'jwt' (generic)
ALTER TABLE users ADD COLUMN refresh_token TEXT;       -- encrypted, for OAuth2
ALTER TABLE users ADD COLUMN token_expires_at TEXT;    -- rename from 'jwt_expires_at'
ALTER TABLE users ADD COLUMN provider_user_id TEXT;    -- MT's internal user ID
```

Migration: existing rows get `provider='codexfit'`. `jwt` → `access_token`, `jwt_expires_at` → `token_expires_at`.

### `auto_bookings` + `auto_upgrades` tables

```sql
ALTER TABLE auto_bookings ADD COLUMN provider TEXT NOT NULL DEFAULT 'codexfit';
ALTER TABLE auto_bookings ADD COLUMN tenant_slug TEXT;
-- Same for auto_upgrades
```

### `studio_preferences` table — collision risk

Current `UNIQUE(user_id, studio_id)` is insufficient when studio ID `"1"` means different studios across providers.

**Option A (recommended): Add provider + tenant_slug to constraint:**
```sql
ALTER TABLE studio_preferences ADD COLUMN provider TEXT NOT NULL DEFAULT 'codexfit';
ALTER TABLE studio_preferences ADD COLUMN tenant_slug TEXT;
CREATE UNIQUE INDEX idx_studio_prefs_unique ON studio_preferences(user_id, provider, tenant_slug, studio_id);
```

**Option B: Compound studio ID string** (`"codexfit:138"`, `"marianatek:spinco:42"`). Simpler migration but less type safety.

### `booking_cache` table

```sql
ALTER TABLE booking_cache ADD COLUMN provider TEXT NOT NULL DEFAULT 'codexfit';
ALTER TABLE booking_cache ADD COLUMN tenant_slug TEXT;
```

### `settings` table — no schema changes

The `preferences` JSON blob is flexible. Client reads/writes per-provider sections:
```json
{
  "providers": {
    "marianatek": {
      "spinco": { "autoUpgradeEnabled": true, "prefetchWeeks": 3 }
    }
  }
}
```

### Tables that do NOT change
- `push_subscriptions` — provider-agnostic
- `sent_notifications` — provider-agnostic
- `server_kv` — provider-agnostic

### Index additions
```sql
CREATE INDEX idx_users_provider ON users(provider, tenant_slug);
CREATE INDEX idx_auto_bookings_provider ON auto_bookings(provider, user_id);
CREATE INDEX idx_auto_upgrades_provider ON auto_upgrades(provider, user_id);
```

---

## 11. Per-Component Impact Analysis

| Component | Effort | Nature of Change |
|-----------|--------|------------------|
| **`auth.js`** | HIGH | Restructured to provider-agnostic orchestrator; OAuth callback; credential ladder for `triggerAutoRelogin` |
| **`server.js`** | HIGH | `proxyRequest()` refactored; cart routes provider-gated; checkout logic moves to adapter |
| **`scheduler.js`** | HIGH | All `fetchCodexFit()` → adapter methods; release-time math → adapter; URL construction → adapter |
| **`poller.js`** | HIGH | Same as scheduler; `normalizeBooking()` → adapter |
| **`db.js`** | MEDIUM | Schema additions; migration paths; new CRUD methods with provider/tenant params |
| **`client/src/api.js`** | LOW-MEDIUM | `login()` accepts provider; new `loginOAuth()`; cart method gating |
| **`client/src/main.js`** | MEDIUM | Login UI with provider selection; OAuth flow initiation |
| **`client/src/ui/timetable.js`** | MEDIUM | Handle namespaced metadata; use server-supplied `releaseTime` |
| **`client/src/ui/bookings.js`** | LOW | Handle provider-scoped booking IDs |
| **`client/src/ui/autobook.js`** | MEDIUM | Countdown uses event `releaseTime` instead of `getNextMondayNoonLondon()` |
| **`client/src/ui/credits.js`** | MEDIUM-HIGH | Conditional: bundle cards (CF) vs. external link (MT) |
| **`client/src/ui/settings.js`** | MEDIUM | Provider-scoped studio lists; hide CF-specific settings for MT |
| **`client/src/lib.js`** | LOW | Deprecation path for `getClassReleaseTime()` |
| **`push.js`** | NONE | VAPID is provider-agnostic |
| **`notifications.js`** | TRIVIAL | Add provider name to notification body for multi-provider users |
| **`crypto.js`** | NONE | Encryption model unchanged |
| **`client/src/ui/spotmap.js`** | NONE | Pure renderer, receives normalized slot data |
| **`client/src/ui/tooltips.js`** | NONE | Provider-agnostic |
| **`client/src/ui/autoupgrade.js`** | TRIVIAL | Passes through API, server handles routing |

---

## 12. Features That May Not Port

### Likely impossible (unless MT exposes undocumented APIs)

| Feature | Reason | Fallback |
|---------|--------|----------|
| **In-app credit purchase** | No documented cart/bundle/checkout API. Checkout via Web Integrations or native app. | "Buy Credits" button → opens MT website. Credit balance display still works. |
| **Third-party push notifications** | MT sends push via own native app infra. No Web Push/VAPID for third-party devs. | Psycle's VAPID push still works for its own notifications, but only if server has active MT access token. Users may get duplicate notifications (MT app + Psycle). |
| **Bookmarks/Favourites sync** | No documented MT bookmark API. | Psycle-native favourites stored client-side in user settings. "Favourites only" filter works with Psycle-native favourites. |

### Requires adaptation (workable but different)

| Feature | Adaptation needed |
|---------|-------------------|
| **Auto-book timing** | MT's `booking_start_datetime` replaces CodexFit's Monday-noon rolling math. Actually **simpler** — release time is directly on the event. But "countdown to next Monday noon" UX becomes "countdown to next release window" (could be any day/time). |
| **Auto-upgrade cutoff** | CodexFit's 12h free-cancellation window drives cutoff logic. MT's cancellation penalty model may differ. `keepOriginalOnCutoff` may need different timing. |
| **Waitlist behavior** | MT has native waitlist auto-fill + SMS. Psycle's auto-upgrade could be partially redundant if MT auto-fills waitlists automatically. |
| **Cart/Checkout** | CodexFit's cart system has no MT equivalent. In-app checkout must be disabled for MT users. |
| **Config Export/Import** | Export format becomes provider-scoped. Import must handle per-provider deduplication. |

### Ports cleanly (same logic, different API)

Timetable, Quick Book, My Bookings, Waitlists, Spot Maps, Profile Explorer, Cancellation Reminders, Booking Window Reminder, Notification Preferences.

---

## 13. Level of Effort Summary

### Overall: L (Large) — 5–8 weeks

> **Updated June 22, 2026:** Reduced from XL (6–10 weeks) after live research confirmed the auth model (headless OAuth works, server-BFF viable) and mapped all key endpoint shapes. Phase 0 research is complete.

Assuming one experienced full-stack developer.

| Phase | Effort | What's Delivered | Risk |
|-------|--------|------------------|------|
| **Phase 0: Research** | ✅ Complete | Auth confirmed (headless OAuth). 83 endpoints mapped. Key endpoints live-tested. | — |
| **Phase 1: Provider abstraction + auth** | 2–3 weeks | Provider interface defined. CodexFit adapter extracted. `auth.js` refactored. DB migrated. CodexFit still works end-to-end. No user-visible changes. | MEDIUM — regression risk on existing features. Heavy test coverage needed. |
| **Phase 2: MT adapter — timetable + booking + waitlist** | 1–2 weeks | MT headless OAuth auth. MT timetable, booking, cancellation, waitlist. Login UI with provider selector. Browse + book MT classes. | MEDIUM — endpoint shapes confirmed, but cancel/waitlist not yet live-tested. |
| **Phase 3: Auto-book + auto-upgrade for MT** | 1–2 weeks | MT release-timing adapter (`booking_start_datetime`). Auto-book works for MT classes. Auto-upgrade via `swap_spots` (confirmed working). | LOW — `swap_spots` confirmed, `booking_start_datetime` confirmed. |
| **Phase 4: Credits, push, spot maps, polish** | 1 week | MT credit/membership display. Spot maps for MT studios (Pick-A-Spot confirmed). Bookmarks (Psycle-native). Config export/import updated. UI polish. | LOW — mostly client-side conditionals. |

### What makes this L rather than M

1. **No existing abstraction** — CodexFit logic is interleaved with business logic across 5 server files. Extracting the adapter cleanly without breaking existing functionality is delicate surgery.
2. **Headless OAuth is more complex than direct login** — 4-step flow (CSRF → login → authorize → token exchange) vs CodexFit's 1-step `POST /auth/login`. Needs a robust implementation with cookie jar management.
3. **Client UI conditional rendering** — every tab with provider-specific content needs conditional logic.
4. **Testing surface** — every feature must be tested against both providers. Mock needs a second provider for dev testing.

---

## 14. Key Architectural Risks

### Risk 1: Refresh token expiry — MEDIUM (downgraded from CRITICAL)

**Impact:** The headless OAuth flow works and the server-BFF model is confirmed viable. However, the refresh token expiry is unknown (likely 30-90 days). If the refresh token expires and the user hasn't opened the PWA, the server must re-run the headless OAuth flow with stored credentials. If the user's password has changed, the server cannot recover autonomously.

**Mitigation:**
- Store encrypted credentials (same as CodexFit model) — server can re-run headless OAuth when refresh token expires.
- Monitor token refresh success and proactively push-notify users before expiry: "Your session expires in 3 days. Open Psycle to keep Auto-Book running."
- The headless OAuth flow is fully automatable (4 steps, no browser needed) — the server can re-authenticate autonomously as long as credentials are valid.

### Risk 2: No MT purchase API — HIGH

**Impact:** In-app credit purchasing can't work for MT studios.

**Mitigation:** Replace Credits tab for MT users with credit balance display + "Buy Credits" button → opens MT website. Add "Low Credits" push notification when balance drops below queued auto-book requirements.

### Risk 3: Multi-tenant subdomain collision — HIGH

**Impact:** Each MT tenant has a different base URL, different OAuth endpoints, and different studio ID namespaces. A user belonging to both "SpinCo" and "YogaBrand" needs two separate MT auth sessions.

**Mitigation:** `tenant_slug` drives all URL construction. A single Psycle user can have multiple provider sessions: `(userId, provider='marianatek', tenant_slug='spinco')` and `(userId, provider='marianatek', tenant_slug='yogabrand')`. PWA login asks "Which studio?" after selecting MT. Studio IDs prefixed as `marianatek:spinco:42`.

### Risk 4: Divergent booking window logic — MEDIUM

**Impact:** CodexFit's "Monday noon + offset" is woven into client countdown, server scheduler, and user mental model. MT's release timing could be any day/time.

**Mitigation:** Server supplies `releaseTime` on each event via adapter. Auto-Book countdown becomes "next release" (soonest among queued classes). Scheduler already handles per-class release time filtering — just needs adapter's `getReleaseTime()`.

### Risk 5: Duplicate notification fatigue — MEDIUM

**Impact:** Users with both MT native app and Psycle PWA receive duplicate notifications.

**Mitigation:** Per-provider notification preferences toggle. For MT bookings made through Psycle, Psycle sends confirmation push. For bookings made through MT app, Psycle detects them during booking-cache refresh and skips notification. UX polish concern, not a launch blocker.

---

## 15. Research Plan (Authorized Follow-Up)

> **Live research was performed June 22, 2026** against `jabboxingclub.marianatek.com` with an authorized test account. P0 items are completed. See sections 1A–1F for findings.

### Completed (P0)

1. ✅ **Test MT password-grant authentication** — Password grant NOT supported by the web integrations client_id (`unauthorized_client`). However, the **headless OAuth flow** (CSRF login → authorize → token exchange) works programmatically. The server-BFF model is viable.
2. ✅ **Obtain authorized MT API access** — Test account on JAB Boxing tenant. OpenAPI schema downloaded (83 endpoints).
3. ✅ **Map MT API endpoints to CodexFit equivalents** — All key endpoints confirmed. See section 1C.
4. ✅ **Test OAuth flow end-to-end** — Headless flow works with `requests` library + cookie jar. No browser needed.
5. ✅ **Confirm MT's booking window model** — `booking_start_datetime` is per-class, publicly visible (`are_booking_windows_public: true`), queryable without auth.

### Remaining tasks

### P1 — Before Phase 2 implementation

6. **Test cancel endpoint**
   - `POST /me/reservations/{id}/cancel` — NOT live-tested (user warned not to cancel)
   - Need a booking we can afford to cancel, or a class with free cancellation window
   - Confirm response shape and whether the `cancel_penalty` check is required first

7. **Test waitlist join + assign_to_spot**
   - `POST /me/reservations` with `reservation_type: "waitlist"` — returns same "payments do not satisfy" error (no credits)
   - Need credits/membership to join a waitlist
   - `POST /me/reservations/{id}/assign_to_spot` — moves waitlist → spot. NOT tested (no waitlisted reservation)

8. **Monitor refresh token expiry**
   - Access tokens last 7 days (604800 seconds)
   - Refresh token works and is NOT rotated
   - Unknown: how long does the refresh token itself last? (Likely 30-90 days — need to monitor or ask MT support)
   - If refresh token expires, server re-runs headless OAuth with stored credentials

### P2 — Before Phase 3–4

9. **Understand MT's cancellation penalty model**
   - `GET /me/reservations/{id}/cancel_penalty` confirmed working — returns `{is_penalty_cancel, message}`
   - Need to test with a class inside the late-cancel window to see `is_penalty_cancel: true`
   - Confirm penalty fee amount and whether it's displayed in the API response

10. **Test waitlist auto-fill behavior**
    - MT has native waitlist auto-fill + SMS. If a spot opens, MT auto-promotes the next waitlisted customer.
    - Does the promoted booking appear in `GET /me/reservations` automatically?
    - Is there a webhook for waitlist fulfillment?
    - Can Psycle detect when a waitlist spot was auto-filled to update auto-book status?

11. **Explore MT webhooks**
    - Contact `integrations@marianatek.com` to register a webhook URL
    - Could webhooks replace polling-based auto-upgrade detection? (More efficient, real-time)
    - What's the webhook payload format for a new reservation? A cancellation?

12. **Cart/checkout flow**
    - `GET /me/reservations/{id}/cart` returned "Authentication credentials were not provided" — may need session auth
    - `POST /locations/{id}/cart/checkout` — not tested
    - JAB is membership-based with no buy-page products; other MT studios may differ

### P3 — Nice to have

13. **Find mobile app client_id**
    - The community CLI `marianatek-pp-cli` found a password-grant flow — likely uses the mobile app's client_id
    - If found, this would simplify auth (one-step password grant instead of 4-step headless OAuth)
    - Try decompiling the JAB Boxing Android APK (`com.marianatek.jabboxingclub`)

14. **Rate limits**
    - Not documented. Monitor for 429 responses during auto-book polling (10ms interval at release time)

15. **Credit purchase API for other MT studios**
    - JAB has no buy-page products (membership-based). Other MT studios (e.g., Barry's) may sell credits via the buy-page API.
    - Test `GET /locations/{id}/buy-page` against a credit-based MT studio.

---

*This document combines desk research (June 22, 2026) with live API testing against `jabboxingclub.marianatek.com` (June 22, 2026). The auth model is now confirmed: headless OAuth flow works, the server-BFF model is viable, and the effort estimate is reduced from XL to L (5–8 weeks). The remaining unknowns (cancel endpoint, waitlist, refresh token expiry) are P1/P2 items that can be resolved during implementation.*
