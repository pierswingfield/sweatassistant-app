# Mariana Tek Platform Research & Multi-Provider Architecture Plan

**Date:** June 22, 2026 (desk research); June 22, 2026 (live API research with JAB Boxing test account)
**Purpose:** Scope what it would take to support gyms/fitness studios that use Mariana Tek as their technology provider, alongside the existing CodexFit integration (Psycle London).

> **Live research performed:** Sections 1A–1F document findings from live API testing against `jabboxingclub.marianatek.com` using an authorized test account. The desk research sections (2–15) follow and are annotated where live findings supersede them.

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
1A. [Live Research Findings — JAB Boxing (jabboxingclub)](#1a-live-research-findings--job-boxing-jabboxingclub)
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
| POST | `/me/account/renewals/failed` | Failed renewal info |
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
| **Credit purchase API for other MT studios** | P3 | Test `GET /locations/{id}/buy-page` against a credit-based MT studio (e.g. Barry's). |

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
which performs an **OAuth2 password grant** for headless/CI use — bypasses browser-based OAuth flow. This suggests a password-grant-like flow exists but is **not officially documented**.

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
| **Bookmarks / favourites** | ❌ Not supported | Low | No mention of a bookmark/favourites API in public Customer API docs. |
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
