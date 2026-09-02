# Mariana Tek Platform Research & Multi-Provider Architecture Plan

**Date:** June 22, 2026 (desk research); June 22, 2026 (live API research with JAB Boxing test account); July 2, 2026 (Phase 0 research round 2 — WP-R1–R4)
**Purpose:** Scope what it would take to support gyms/fitness studios that use Mariana Tek as their technology provider, alongside the existing CodexFit integration (Psycle London).

> **Live research performed:** Sections 1A–1F document findings from live API testing against `jabboxingclub.marianatek.com` using an authorized test account (June 22, 2026). Section 1G documents a follow-up live research round (July 2, 2026) that re-validated the auth flow and resolved most of §1F's open questions. The desk research sections (2–15) follow and are annotated where live findings supersede them.

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
1A. [Live Research Findings — JAB Boxing (jabboxingclub)](#1a-live-research-findings--job-boxing-jabboxingclub)
1B. [Confirmed Auth Flow](#1b-confirmed-auth-flow)
1C. [Confirmed Endpoint Map](#1c-confirmed-endpoint-map)
1D. [Confirmed Data Schemas](#1d-confirmed-data-schemas)
1E. [JAB Boxing Specifics](#1e-jab-boxing-specifics)
1F. [Remaining Unknowns After Live Research](#1f-remaining-unknowns-after-live-research)
1G. [Live Research Round 2 (2026-07-02)](#1g-live-research-round-2-2026-07-02--phase-0-wp-r1r4)
1H. [Production Account Capture (2026-07-02)](#1h-production-account-capture-2026-07-02--resolves-r2s-remaining-p1-unknowns)
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
  "booked_by": "Jane Doe",
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

> **Updated 2026-07-02 — see §1G below for the round-2 live research session that resolved/refined several of these.**

| Unknown | Priority | Status (2026-07-02) | How to resolve |
|---------|----------|----------------------|-----------------|
| **Cancel endpoint behavior** | P1 | ✅ **Resolved** via production-account capture — see §1H. Cancel-within-window restores usage/allowance, not just fee-free. | Done. |
| **Waitlist join + assign_to_spot** | P1 | ✅ **Join + leave resolved** via production-account capture — see §1H. `assign_to_spot` (promotion when a spot frees up) still unexercised — opportunistic only, not worth forcing. | `assign_to_spot` remains open; low priority. |
| **Refresh token expiry** | P1 | **Partially resolved.** Confirmed today: fresh headless-OAuth login works, `refresh_token` grant works, refresh token is **not rotated** (same token returned), access token is 7 days (604800s) each time. An **invalid/dead refresh token** now has a confirmed failure shape: `400 {"error": "invalid_grant"}` — this is the exact condition the credential-ladder's "re-login with stored password" fallback should trigger on. **Still unknown:** the hard expiry window itself (30/60/90d?) — this requires waiting weeks and cannot be forced in a single session. No token-introspection endpoint exists to shortcut this (confirmed — the live OpenAPI schema at `docs.marianatek.com/api/customer/v1/schema/` contains only `/o/authorize` and `/o/token`, no `/o/introspect` or `/o/revoke`). | Time-based monitoring only — re-run the refresh grant periodically (e.g. a scheduled trigger every ~2 weeks) and note the first date it fails with `invalid_grant` while the access token itself is still theoretically fresh (i.e. a *refresh*-token expiry, not just an access-token expiry). |
| **Cart/checkout flow** | P2 | Not re-tested this round (out of scope — no purchase/checkout flows attempted, per hard safety boundary). | Still open. |
| **Credit purchase API** | P2 | Not re-tested. JAB confirmed still membership-based with an empty buy-page (see §1G). | Other MT studios may have buy-page products — untested. |
| **Webhooks** | P2 | Not pursued this round. | Contact `integrations@marianatek.com` to register a webhook URL. |
| **Rate limits** | P3 | **Refined.** ~35 GET/POST requests made across this session (auth flow + reads + a couple of intentionally-invalid probes) with zero `429`s and **zero rate-limit-related response headers** of any kind (`X-RateLimit-*`, `Retry-After` — grepped every response header on every call, none present). This is a light-touch sample, not a stress test — genuinely unknown behavior under sustained/concurrent polling (e.g. the scheduler's T-0 dispatch burst) remains untested. | Continue monitoring naturally during Phase 4/6 implementation and integration testing; do not deliberately stress-test a shared tenant. |
| **Mobile app client_id** | P3 | Not pursued this round. | Still open. |
| **Credit purchase API for other MT studios** | P3 | Not pursued this round. | Still open. |
| **Insufficient-payment error shape** *(new, resolves part of R4)* | — | **Resolved via existing §1D data**, not re-triggered this round. §1D already documents the exact shape from the June 22 session: `{"non_field_errors": ["The payments do not satisfy the cost of this reservation."]}`. A live re-trigger this round was declined — see §1G gotchas for why. | — |
| **Bad/garbage bearer token error shape** *(new)* | — | **Resolved.** `GET /me/account` with an invalid `Authorization: Bearer` header returns the **same** `401 {"detail": "Authentication credentials were not provided."}` as no auth header at all — MT does not distinguish "missing" vs "malformed/invalid" credentials in the response body. Useful for the adapter's re-login-trigger logic: treat any 401 on an authenticated read as "re-authenticate," don't try to parse a more specific reason. | — |
| **404 error shape** *(new)* | — | **Resolved.** `GET /classes/{bad_id}` → `404 {"detail": "No ClassSession matches the given query."}`. Consistent DRF-style `detail` field across error types observed so far (401, 404; `invalid_grant` on the OAuth token endpoint is the one exception, using `error` instead of `detail`). | — |
| **FCFS class detail shape** *(new)* | — | **Resolved.** `GET /classes/{id}` for a `first-come-first-serve` class (e.g. RECOVERY) returns `"layout": null` — no `spots` array at all, confirming the adapter/UI must branch on `layout_format` and simply not attempt to render a floor plan for FCFS classes rather than expecting an empty array. | — |

---

## 1G. Live Research Round 2 (2026-07-02) — Phase 0 WP-R1–R4

**Purpose:** Phase 0 research work packages (PLAN.md §4) — re-validate the auth flow ~10 days after the original research, attempt the P1 write-path unknowns (cancel, waitlist), capture fixtures for the adapter's normalization layer, and note any rate-limit/error-taxonomy observations along the way.

**Test account:** `aiproscw@gmail.com` (Sebastian Clearwater, user id 60623) — unchanged from §1A.

### WP-R1 — Auth lifecycle: confirmed still working today

Re-ran the exact 4-step headless OAuth flow from §1B, fresh, ~10 days after the original research:

| Step | Result |
|------|--------|
| PKCE generation + `GET /o/authorize/` → login page redirect | ✅ Identical shape to §1B — CSRF token extractable from the login HTML form, `csrftoken` cookie set |
| `POST /auth/login/` with credentials | ✅ 302 redirect chain → `{redirect_uri}?code=...`, exactly as documented |
| `POST /o/token/` code exchange | ✅ `{access_token, expires_in: 604800, token_type: "Bearer", scope: "read:account", refresh_token}` — byte-identical shape to §1B, no schema drift |
| `POST /o/token/` refresh grant | ✅ Works. New `access_token` issued, `refresh_token` **not rotated** (same token returned), `expires_in: 604800` again |
| Invalid/garbage `refresh_token` grant | ✅ New this round — `400 {"error": "invalid_grant"}`. This is the exact signal the credential ladder (marianatek.md §4, PLAN.md §2.2) should treat as "refresh is dead, fall back to full re-login with stored password." |
| Token introspection endpoint | ❌ Confirmed does not exist — downloaded the live OpenAPI schema (`docs.marianatek.com/api/customer/v1/schema/`, 302KB) and grepped for `/o/*` paths: only `/o/authorize` and `/o/token` are present. No way to ask MT "how much longer is this refresh token valid" short of using it and seeing if it works. |

**Conclusion:** Nothing has silently changed in ~10 days — the auth flow is stable and repeatable. The refresh-token **hard expiry window** (30/60/90 days, PLAN.md Open Question Q1) genuinely cannot be determined without waiting weeks; this session did not attempt to force that. Recommend a scheduled check (e.g. a monthly trigger that runs the refresh grant and logs pass/fail) rather than a one-off session, to eventually pin down the real window empirically.

### WP-R2 — Write-path validation: blocked by account/schedule state, not by the API

Checked `GET /me/credits` and `GET /me/memberships` fresh: both still return empty results (`count: 0`) — the test account remains $0/no-membership, unchanged since June 22.

Searched the live schedule exhaustively for a `is_free_class: true` class to test the one write path that doesn't need payment: scanned **2,067 upcoming class sessions** across a ~2.5-month window (today through mid-September, using `page_size=100` pagination) via `GET /classes`. **Zero** classes have `is_free_class: true` anywhere in that window. The class catalog for JAB is exactly the 16 recurring class types listed in §1E (TRAIN variants, BOXING variants, RECOVERY, Small Group PT, SPARRING, etc.) — none are flagged free.

Given that, both P1 unknowns from §1F remain genuinely blocked on this account:
- **`POST /me/reservations/{id}/cancel`** — never reached, because no reservation can be created to cancel (no credits, no membership, no free class).
- **Waitlist join (`reservation_type: "waitlist"`) + `assign_to_spot`** — same root cause; joining a waitlist on this tenant is payment-gated exactly like a standard booking, and the account has nothing to pay with.

This is a legitimate, documented outcome, not a shortfall in this session's effort — see the coordinator's mid-session guidance (relayed, not independently re-verified against the stakeholder) that the stakeholder plans to resolve these two specifically via **manual browser-based capture against a real production MarianaTek account with actual credits**, separately from this test-account session. That plan is the right one: forcing a resolution here would require either purchasing something (explicitly out of bounds — see the hard safety boundary) or the account having state it simply doesn't have.

**Did not re-attempt** a live `POST /me/reservations` against a paid class this round to re-capture the "insufficient payment" error text — the environment's own safety classifier declined that action mid-session (it read as a payment-adjacent write given the account's known $0 state, even though the endpoint is expected to reject it harmlessly). That specific error shape was **already fully captured** in the June 22 session and is documented verbatim in §1D: `{"non_field_errors": ["The payments do not satisfy the cost of this reservation."]}`. No need to reproduce it live again — it's already real, already correct, and re-triggering it would have added no new information.

`swap_spots` was not re-tested this round (already confirmed working in §1A/§1C; no reservation exists on the account to swap right now anyway).

### WP-R3 — Fixtures captured

All saved under `server/__fixtures__/marianatek/` (real, live JSON responses; no tokens or passwords included in any fixture file — verified by grep):

| File | Source call | Notes |
|------|-------------|-------|
| `classes-list.json` | `GET /classes?min_start_date=...&max_start_date=...` | First page (10 results) of the live schedule, standard DRF pagination envelope (`results`, `meta.pagination`, `links`) |
| `class-detail-with-layout.json` | `GET /classes/79121` | `TRAIN - Core & Glutes`, `layout_format: "pick-a-spot"`, full 40-spot `layout.spots` array with `x_position`/`y_position`/`spot_type`/`is_available` |
| `class-detail-fcfs.json` | `GET /classes/79103` | `RECOVERY (Members)`, `layout_format: "first-come-first-serve"`, confirms `"layout": null` for FCFS classes (see §1F) |
| `me-account.json` | `GET /me/account` | Full profile incl. `home_location`, `required_legal_documents`, waiver status |
| `me-credits.json` | `GET /me/credits` | Empty (`count: 0`) — confirms account still has no credit packages |
| `me-memberships.json` | `GET /me/memberships` | Empty (`count: 0`) — confirms account still has no membership |
| `me-reservations.json` | `GET /me/reservations` | Empty (`count: 0`) — account has no bookings, historical or upcoming |
| `locations.json` | `GET /locations` (public, no auth) | Both JAB locations, SW1 (id 48751) and EC1 (id 48784) |

**Not captured** (blocked by WP-R2's account-state limitation, not attempted): `booking-response.json`, `waitlist-response.json`, `cancel-penalty-response.json`. These need the production-account browser capture mentioned above; once available, drop them into the same fixtures directory using the same naming convention.

**Field-mapping note for Phase 4 (WP-M2):** `class-detail-with-layout.json`'s `layout.spots[]` entries map cleanly onto PLAN.md §2.3's draft `NormalizedSlot` shape (`id`→`id`, `name`→`label`, `x_position`/`y_position`→`x`/`y`, `spot_type.is_primary`→`isPrimary`, `is_available`→`isAvailable`; `row` has no direct MT equivalent — Pick-A-Spot has no row concept, only x/y, so `row` should stay `undefined` for MT-sourced slots per `normalize.js`'s undefined-pruning behavior). Top-level class fields map onto `NormalizedEvent` per PLAN.md's table almost verbatim (`start_datetime`→`startAt`, `booking_start_datetime`→`releaseAt`, `available_spot_count`→`availableCount`, `is_user_reserved`→`isUserBooked`, `is_user_waitlisted`→`isUserWaitlisted`).

### WP-R4 — Rate limits & error taxonomy

**Rate limits:** Made roughly 35 requests this session (auth flow steps + reads + a handful of intentionally-invalid probes for error-shape capture), all within a few minutes, no artificial delay beyond a courtesy 0.2–0.3s between paginated calls. **Zero `429` responses. Zero rate-limit-related response headers** on any call — every response header set was inspected (not just skimmed) for anything containing "rate" or `Retry-After`; none found on any endpoint (public or authenticated, OAuth or Customer API). This matches §1F's original "not publicly documented" note — MT simply doesn't surface rate-limit signals to this client, at least not at this (light) request volume. No conclusions possible about behavior under real sustained load (e.g. the auto-book scheduler's T-0 burst); that can only be observed opportunistically during later phases, not manufactured safely against a shared tenant.

**Error taxonomy — new entries this round:**

| Scenario | HTTP status | Body shape |
|----------|-------------|------------|
| Invalid/expired `refresh_token` grant | 400 | `{"error": "invalid_grant"}` |
| No `Authorization` header on an authenticated read | 401 | `{"detail": "Authentication credentials were not provided."}` |
| Garbage/invalid `Authorization: Bearer` token | 401 | `{"detail": "Authentication credentials were not provided."}` — **identical** to the no-header case; MT does not distinguish missing vs. malformed credentials |
| Unknown/nonexistent resource id (`GET /classes/{bad_id}`) | 404 | `{"detail": "No ClassSession matches the given query."}` |
| Insufficient payment for a booking (from §1D, June 22 session, not re-triggered) | 200 with an error body (per §1A's original note) | `{"non_field_errors": ["The payments do not satisfy the cost of this reservation."]}` |

**Pattern observed:** Customer API errors use a DRF-standard `detail` string for auth/not-found errors; the OAuth token endpoint (`/o/token/`) uses a different, OAuth2-spec-standard `error` field instead; booking-validation errors use DRF's `non_field_errors` array. Three distinct shapes depending on which subsystem produced the error — the adapter's error-normalization layer should switch on which of these three keys is present rather than assuming one consistent shape across the whole API surface.

### Session artifacts (not committed — informational only)

The Python scripts used to drive this session (headless OAuth client, generic API client, class-scanning helper) and their raw request/response logs live in a scratch directory outside the repo, not under version control — they were throwaway research tooling, not part of the codebase. If a future agent wants a ready-made headless-OAuth-flow reference implementation to build the real `server/providers/marianatek.js` auth methods (WP-M1) from, ask for them to be regenerated rather than assuming they persist; the durable output of this session is this document + the fixtures directory, not the scratch scripts.

---

## 1H. Production Account Capture (2026-07-02) — resolves R2's remaining P1 unknowns

**Source:** the stakeholder manually captured browser network-tab traffic (request/response JSON) from a **real, paying JAB Boxing production member account** — not the `aiproscw@gmail.com` test account, which structurally cannot produce these flows (§1G: $0 credits, no membership, zero free classes anywhere in the schedule). This finally exercises the credit/membership-gated write paths the test account was blocked from reaching.

**⚠️ Handling note for future readers:** the raw capture contained the account holder's real PII (name, DOB, phone, email, credit card metadata, Stripe customer id, presigned S3 URLs with AWS security tokens for signed legal documents) and a live OAuth bearer token. **None of that is reproduced here or in the fixtures.** Every fixture under `server/__fixtures__/marianatek/prod-*.json` is sanitized — personal values replaced with `REDACTED_*` placeholders, only the response *shape* and non-personal values (studio locations, membership status booleans, spot ids, availability counts) are real. If you're extending this research, apply the same discipline: capture what you need, redact before it touches the repo.

### What this resolved

| §1F unknown | Resolution |
|---|---|
| **Cancel endpoint behavior** (P1) | ✅ **Resolved.** `cancel_penalty` → `{"is_penalty_cancel": false, "message": null}` when well within the free window (matches §1D's shape, now confirmed against a real chargeable account). `POST /me/reservations/{id}/cancel` on a **standard** booking sets `status: "standard cancel"`. **New finding:** cancelling within the zero-penalty window **restores the underlying usage/allowance**, not just "no fee charged" — observed directly via `membership_payment.guest_remaining_usage_count` going `2 → 1` (after booking a guest) `→ 2` (after cancelling that guest booking). See `prod-cancel-flow.json`. |
| **Waitlist join + assign_to_spot** (P1) | ✅ **Partially resolved** — waitlist *join* and *leave* both confirmed working end-to-end against a genuinely full class. `reservation_type: "waitlist"` produces a reservation with an all-empty `spot` object (`{id:"", name:"", ...}`, not null/omitted) and `status: "pending"`; `waitlist_position` stayed `null` throughout on this tenant — don't rely on it for UI. **Leaving** a waitlist sets `status: "removed"` — a **different terminal status than a standard cancel** (`"standard cancel"`); the adapter's status-mapping must branch on `reservation_type`, not assume one cancel-status vocabulary. `assign_to_spot` (waitlist → confirmed spot, from the community-CLI-discovered endpoint in §7) was **not** exercised — no spot opened up during this capture window. See `prod-waitlist-flow.json`. |
| Insufficient-payment error shape | Unchanged — still the §1D shape, not re-triggered this round (real booking succeeded instead, since this account has a real membership). |

### New endpoints discovered (not in §1C)

| Method | Endpoint | Purpose | Fixture |
|---|---|---|---|
| GET | `/classes/{id}/payment_options` | Returns `{user_payment_options: [...], guest_payment_options: [...]}` — the valid `payment_option.id` values (e.g. `"membership-2552"`) to pass into `POST /me/reservations`. **The adapter's `bookSlot()` needs to call this before booking on a membership-based gym** — don't assume a fixed payment_option shape. | `prod-payment-options.json` |
| GET | `/me/achievements` | `{classes_completed, instructors_taken, member_since, most_visited_studio, number_of_studios_visited}` — user stats, not needed for M1–M3 core booking but a nice-to-have for a future stats panel. | `prod-achievements.json` |
| GET | `/me/orders?reservation={id}&exclude_statuses=Cancelled` | Empty result set for a membership-paid booking (makes sense — a membership deduction isn't a purchase "order"). Presumably populated for credit-pack purchases; untested. | — (empty response, not worth a fixture) |
| GET | `{tenant}.marianaiframes.com/feature-flags?userId={id}` | MT's own web-integrations SPA feature flags — **not** the Customer API, different domain, not an adapter concern. Documented for completeness only. | `prod-feature-flags.json` |

### Confirmed request/response shapes (previously only hypothesized)

- **Membership-based booking** (as opposed to credit-based): `POST /me/reservations` body includes `payment_option: {id: "membership-{id}"}`. Response's `payment_option.membership_payment` carries `status`, `guest_usage_limit`, `guest_remaining_usage_count`, `commitment_length`, `payment_interval`, `booking_window_display` — richer than the credit-based shape assumed in §1D.
- **Guest booking**: `is_booked_for_me: false` + a required `guest_email` (booking without it fails cleanly: `{"non_field_errors": ["Email address for guest must be provided"]}`). A guest booking consumes one unit of `guest_remaining_usage_count` on the host's membership, and — per the cancel finding above — that unit is restored on a zero-penalty cancel.
- **`GET /me/account` on a real member** looks meaningfully different from the test account's near-empty shape: real accounts carry a `credit_cards` array (each card scoped to specific `usage_locations`!), a `stripe_customer_id`, and populated legal-document/waiver tracking. The adapter's `NormalizedProfile` builder should treat most of these fields as optional/gym-dependent rather than modeling on the test account's minimal shape. See `prod-me-account.json` (heavily redacted).

### Booking window: confirmed self-describing per class (no per-gym inference logic needed)

**Question:** does the adapter need gym-specific logic to figure out how far in advance booking opens (JAB: rolling 7-day base / 14-day member; other MT gyms like Aarmy reportedly do a fixed weekly release like CodexFit)?

**Answer: no — `booking_start_datetime` on every `class_session` object is already the fully-resolved release datetime for the *viewing account*, computed server-side by MT.** Confirmed by recomputing the gap on two independent classes from the `prod-*.json` fixtures (both against the same 14-day-member account):

| Class | `booking_start_datetime` | class `start_datetime` | gap |
|---|---|---|---|
| BOXING Core & Power (`prod-cancel-flow.json` source booking) | `2026-06-21T09:00:00+01:00` | `2026-07-05T08:00:00Z` | **exactly 14 days** |
| BOXING Core & Power, waitlisted class (`prod-waitlist-flow.json`) | `2026-06-19T07:00:00+01:00` | `2026-07-03T06:00:00Z` | **exactly 14 days** |

This matches the account's membership `booking_window_display: "Reserve 14 days in advance"` (visible directly in `prod-payment-options.json`) exactly — and it's not a coincidence: this is the field's actual purpose. §5 "Booking Windows" (desk research) already noted MT supports both **Interval** (fixed weekly release, e.g. Aarmy/Psycle-style) and **Rolling** (continuously-evaluated, e.g. JAB-style) window configurations, set per studio and potentially per membership/credit tier — this live data confirms MT resolves whichever rule applies *server-side* and simply publishes the answer as `booking_start_datetime`. **The adapter never needs to know which window type a given gym uses, or replicate CodexFit's `detectBookingWindow()`-style client-side inference (`client/src/lib.js`) — it just reads the field.** This directly satisfies `NormalizedEvent.releaseAt` (already in the `base.js` typedef) with zero extra logic: `releaseAt = class.booking_start_datetime`. This is a genuine simplification vs. CodexFit and should make WP-M2 (timetable+layout normalization) and WP-S1 (auto-book on normalized `releaseAt`) straightforward for the booking-window piece specifically.

**Not yet confirmed:** what a non-member (base 7-day window) viewer sees for the same class — every capture so far is from a 14-day-member account, so this is inferred from the membership's own `booking_window_display`, not cross-checked against a base-tier account. Low priority to chase separately, since the mechanism (trust `booking_start_datetime`, don't compute it) is what matters for the adapter regardless of which number comes back.

### Still open after this round

- `assign_to_spot` (moving a waitlisted reservation onto a spot that just opened) — needs a capture at the exact moment a spot frees up on a full class; not something to force, opportunistic only.
- Credit-based (non-membership) booking — this production account is membership-based like the test account's tenant defaults suggest is common for JAB; a credit-pack-based MT studio (e.g. Barry's, per §8) would need separate capture to confirm `credit_payment` shape.
- The refresh-token hard expiry window (Q1) — unaffected by this round, still needs time-based monitoring per §1G.
- **`cancel_penalty` response when a class IS within the penalty window (new).** Every `cancel_penalty` capture in §1H returned `{"is_penalty_cancel": false, "message": null}` — the stakeholder deliberately cancelled bookings well within the free window (by design, to avoid any real penalty). We have **no captured example** of: the response shape when `is_penalty_cancel: true` (exact `message` wording — does it state a fee amount? a cutoff time?), whether the subsequent `POST /cancel` still succeeds (charging a fee) or is blocked/requires extra confirmation, and — the important one for the adapter — **whether membership usage/allowance is restored on a *penalty* cancel the way it's confirmed restored on a free one** (§1H's book→cancel→usage-count finding only covers the zero-penalty case). This matters directly for `server/poller.js`'s auto-upgrade cutoff logic (`CUTOFF_BUFFER_S`, stops attempting spot changes near the free-cancellation boundary for CodexFit) — the MT adapter's equivalent (`WP-S2`) needs to know MT's actual penalty-window boundary and behavior, not assume it mirrors CodexFit's. **Resolve opportunistically**: next time the stakeholder (or a test/production account) has a booking that naturally falls inside its penalty window and they're willing to let it be cancelled anyway, capture `cancel_penalty` + the `cancel` response the same way as §1H.

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
