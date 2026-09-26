# Sweat Assistant — Modular Multi-Gym Refactor: Master Plan

> **Status:** Planning complete, implementation not started.
> **Owner doc:** This is the authoritative plan. Progress is tracked in [PROGRESS.md](./PROGRESS.md). Agents must read [AGENT_INSTRUCTIONS.md](./AGENT_INSTRUCTIONS.md) before touching code.
> **First target:** MarianaTek support for **JAB Boxing Club** (`jabboxingclub` tenant), alongside existing CodexFit/Psycle London.
> **Last updated:** 2026-07-01

---

## 0. Locked Decisions (from stakeholder)

These three decisions were confirmed on 2026-07-01 and shape everything below. Changing them invalidates large parts of the plan — see [Decisions Log](./PROGRESS.md#decisions-log) before revisiting.

| # | Decision | Choice | Consequence |
|---|----------|--------|-------------|
| D1 | **Membership model** | **Multiple gyms per account** | A `user_gyms` join table holds per-gym credentials + sessions. One Sweat account can link both Psycle and JAB. UI needs a gym switcher and a merged/switchable timetable. This is the largest schema change. |
| D2 | **Branding** | **"Sweat Assistant"** umbrella | Neutral umbrella brand; per-gym theming (Psycle violet, JAB navy `#18214D`) layered on top. Update `manifest.json`, `app.config.json`, copy defaults. Supersedes the older "Psycle Assistant" single-gym name. |
| D3 | **JAB v1 scope** | **Full parity, purchases de-scopable** | Aim for feature parity, but credit/bundle **purchase** may be dropped for JAB (membership-based, no confirmed MT purchase API). Bookmarks likewise have no MT API — ship a graceful "unsupported" state, not a blocker. |

---

## 1. Executive Summary

The app is currently hardcoded to one provider (CodexFit) and one gym (Psycle London). CodexFit specifics — base URL `https://psycle.codexfit.com`, headers `origin/referer/x-organisation`, event/slot data shapes, Monday-noon release math, cancel-then-rebook spot swaps — are interleaved with business logic across **~108 references in 5 server files** (`server.js`, `auth.js`, `scheduler.js`, `poller.js`, `calendar.js`) and **~15 references in the client** (`api.js`, `lib.js`, `bookings.js`, `credits.js`, `timetable.js`).

The refactor introduces a **provider abstraction layer** on the server (a `GymProvider` interface with CodexFit and MarianaTek adapters), a **normalized data model** the rest of the app speaks, a **multi-gym data model** (`gyms` + `user_gyms`), and a **normalized client API** so the PWA stops speaking raw CodexFit. MarianaTek is well-documented and its auth + core endpoints were **live-validated against the JAB test account** (see [marianatek.md](../../Services/marianatek.md) §1A–1F) — the key risk is not MarianaTek itself but disentangling CodexFit from business logic without regressing the working Psycle app.

**Effort:** L (5–8 weeks single-dev-equivalent), driven by the normalization + multi-gym data model, not the MT adapter. Sequenced so **Psycle keeps working at every phase boundary**.

---

## 2. Rigorous Analysis

### 2.1 UX Considerations

| Area | Consideration | Direction |
|------|--------------|-----------|
| **Account & gym linking** | With multi-gym accounts (D1), the "login = your gym login" assumption breaks. First gym login bootstraps the Sweat account; adding a second gym is a separate "link a gym" flow with that gym's credentials. Two gyms may use different emails → account is Sweat-level, not gym-email-level. | Onboarding gains a "Choose your gym" step; Settings gains "Linked gyms" management. Local JWT identifies the **account**, not a gym session. |
| **Gym switcher** | Users need to switch active gym context (timetable, bookings, auto-book all scoped to a gym). | Persistent gym switcher (top bar / segmented control). Active gym persisted (`sweatActiveGymId`). Optionally a merged "All gyms" timetable view (stretch). |
| **Theming** | Psycle (violet) vs JAB (navy `#18214D`, Gothic A1 font). Theme must follow the active gym, on top of the existing auto/light/dark toggle. | Per-gym theme tokens injected from gym config; compose with existing light/dark. Theme must not flash on switch. |
| **Feature availability** | JAB has no credit-purchase API and MarianaTek has no bookmarks. Showing a broken "Buy Credits" or "Favourites" tab is bad UX. | Capability flags per provider drive UI visibility. Unsupported features are hidden or show an explicit "Not available for this gym" state — never a dead button. |
| **Booking-window semantics** | CodexFit = single rolling Monday-noon release for the whole timetable. MarianaTek = per-class `booking_start_datetime` (e.g. 7 days before each class). The "when does this open?" countdown and auto-book timing differ fundamentally. | Countdown/release UI reads a normalized `releaseAt` per event. Copy generalizes away from "Monday noon". |
| **Floor plan / spot map** | CodexFit rows/columns vs MarianaTek x/y `pick-a-spot` (40 spots) and `first-come-first-serve` (no spots, e.g. JAB RECOVERY). Shared spot-map preferences must survive per (gym, studio). | Floor-plan renderers consume **normalized slots**; FCFS classes show no picker. Preferred-spot maps keyed by `(user, gym, studio)` so IDs never collide across providers. |
| **Waitlist mental model** | MarianaTek natively auto-fills waitlists via its own SMS. Our auto-upgrade could conflict/overlap with MT's native behavior. | Clarify in-app that MT handles some promotion natively; position our auto-upgrade as spot-quality optimization (`swap_spots`), not waitlist promotion, for MT. |
| **Terminology** | "Class" vs "ride" vs "session"; "spot" vs "bike" vs "slot". | Normalized, gym-neutral terms in shared UI ("class", "spot"); allow per-gym label overrides in gym config for flavor. |

### 2.2 Logic / Behavioral Considerations

| Concern | CodexFit today | MarianaTek | Normalization decision |
|---------|----------------|------------|------------------------|
| **Auth** | 1-step direct login → JWT; auto-relogin on 401 with stored password. | 4-step headless OAuth (PKCE): CSRF login → authorize → token exchange → 7-day access token + non-rotating refresh token. Refresh every 7d; re-run headless OAuth if refresh dies. | Adapter `login/validateSession/refreshSession`. Server stores an opaque per-gym **session bundle** (`session_json`) + encrypted password. A **credential ladder** (accessToken → refresh → re-login → notify) lives in the adapter. |
| **Release timing (auto-book)** | Computed Monday 12:00 London, offset by membership tier; T-50s prefetch, T-0 dispatch. | `booking_start_datetime` published per class session. | Normalize to `event.releaseAt` (ISO). Scheduler arms timers off `releaseAt` regardless of provider. CodexFit adapter computes it; MT adapter reads it. |
| **Booking write** | `POST /bookings` → `{ success, bookings: { bookingId: slotId } }`. | `POST /me/reservations` `{ class_session:{id}, reservation_type }` → reservation object. | Adapter `bookSlot()` returns `NormalizedBookingResult { bookingId, slotId, raw }`. |
| **Spot swap (auto-upgrade)** | **No atomic swap** — cancel `DELETE /bookings/{id}` then re-`POST`. Risk window. | **Native** `POST /me/reservations/{id}/swap_spots {spot}`. | Adapter `swapSpots()`; CodexFit implements cancel-rebook internally, MT calls native. Capability flag `atomicSwap` informs risk messaging. |
| **Waitlist** | Not native; join/leave via events. | `reservation_type:"waitlist"`, native auto-fill + `assign_to_spot`. | Adapter `joinWaitlist/leaveWaitlist`. MT auto-fill is native — poller must not double-act. |
| **Cancel penalty** | Free-cancel window math client/server. | `GET /me/reservations/{id}/cancel_penalty` (read-only, safe). | Adapter `getCancelPenalty()`; prefer provider truth (MT) over computed window where available. |
| **Cross-user slot coordination** | `claimedSlots`/`burnedSlots` Sets keyed `eventId:slotId`, `CLAIM_STAGGER_MS`. | Same concept applies (Pick-A-Spot). | Keep the coordination logic in the scheduler but key by `(gymId,eventId,slotId)` to prevent cross-gym collisions. |
| **Public reads** | `/events`, `/studios` etc. proxied without token. | `/classes`, `/locations` etc. public, no auth. | Adapter marks which normalized reads are public; server strips auth accordingly. |
| **Dev mock** | `dev@psycle.com` → `mock.js`. | Needs an MT mock for a JAB-flavored dev account. | Add `mock-marianatek.js` + a `dev@jab.com` (or gym-scoped dev) path. |

### 2.3 Technical / Architecture Considerations

- **Leaky abstraction to fix first:** the client calls `/api/proxy/{raw CodexFit path}` (`api.js` `proxyGet/Post/Put/Delete`). This cannot work for MT (different endpoints + shapes). The server must expose **normalized endpoints** (`/api/timetable`, `/api/events/:id`, `/api/book`, …) and the client must stop constructing provider paths. This is the single biggest client change.
- **Provider resolution:** every authenticated request resolves `gym → provider` via the user's active gym (`user_gyms`) or an `x-gym-id` header for pre-login/public browsing. A `providers/index.js` factory returns the adapter.
- **Session storage:** move CodexFit creds off `users` onto `user_gyms` (`encrypted_password`, `session_json`, `token_expires_at`, `display_name`, `profile_json`, `calendar_token`, `priority`, `status`). `users` keeps account identity (email + local auth).
- **ID collisions:** CodexFit and MT numeric IDs (studios, events, slots) can collide. All per-user, per-gym tables key by `(user_id, gym_id, …)`. Spot maps by `(user_id, gym_id, studio_id)`.
- **Config source of truth:** gym provider wiring (base URLs, OAuth client_id, headers, theme, feature flags) lives in a **static `server/gyms.config.js` registry** (code, secrets via env), with a thin `gyms` DB table for referential integrity / admin display. Rationale: gyms are few, adding one is a code change anyway, and client_ids/headers shouldn't live in the DB. (Tradeoff noted; revisit if self-service gym onboarding is ever needed.)
- **Behavior-preserving extraction:** Phase 1 extracts CodexFit into an adapter **without changing behavior** — Psycle must be byte-for-byte equivalent. This de-risks everything downstream.
- **Normalized shapes** (draft — finalize in WP-A1):
  - `NormalizedEvent`: `{ id, gymId, name, discipline, startAt, endAt, releaseAt, locationId, locationName, studioId, studioName, instructors[], capacity, availableCount, waitlistCount, layoutFormat, isUserBooked, isUserWaitlisted, raw }`
  - `NormalizedSlot`: `{ id, label, x, y, row, isAvailable, isPrimary, spotType, raw }`
  - `AuthSession`: `{ accessToken, refreshToken?, expiresAt, meta }`
  - `NormalizedBookingResult`: `{ ok, bookingId, slotId, error, raw }`
  - `ProviderCapabilities`: `{ atomicSwap, nativeWaitlist, creditPurchase, bookmarks, bookingWindow: 'rolling-weekly'|'per-class', publicReads[] }`
- **Backwards compatibility:** keep a Psycle compatibility shim (normalized endpoints proxying to the CodexFit adapter) so the client can migrate incrementally rather than in one big-bang cutover.

### 2.4 Management / Process Considerations

- **Sequencing preserves a working app:** each phase ends with Psycle fully functional and (from Phase 4) JAB progressively enabled behind a flag. Never leave `master` broken.
- **Multi-agent handoff:** work is decomposed into **work packages (WP-xx)** with explicit dependencies, acceptance criteria, and a shared status board (PROGRESS.md). Any agent resumes by reading PLAN + PROGRESS + last handoff entry. See [AGENT_INSTRUCTIONS.md](./AGENT_INSTRUCTIONS.md).
- **Branch strategy:** feature branch `modular` (already checked out) as integration branch; per-WP sub-branches merged into `modular`; `modular` → `master` only at tested phase boundaries.
- **Safety rails:** JAB writes (book/cancel) are tested **only** on the authorized test account (`aiproscw@gmail.com`, Sebastian Clearwater). **Never** cancel real bookings (credit not returned — see research §1F). Destructive MT calls stay behind explicit test guards.
- **Definition of done per WP:** code + tests + PROGRESS update + handoff note + Psycle regression green.
- **Rollout:** feature-flag JAB (`gym.enabled`) so it can ship dark and be enabled per-account.

### 2.5 Documentation Considerations

- **AGENTS.md** needs a "Providers" section (abstraction, how to add a gym) and updates to every place that says "CodexFit"/"Psycle" as if singular (proxy, scheduler, schema, routes).
- **New provider-authoring guide** (`Documentation/Services/adding-a-provider.md`) — the checklist to implement a new `GymProvider`.
- **Schema doc** (AGENTS.md SQLite section) updated for `gyms`, `user_gyms`, and `gym_id` columns.
- **API routes doc** updated for normalized endpoints.
- **Research doc** ([marianatek.md](../../Services/marianatek.md)) gets its §1F unknowns resolved and annotated as Phase 0 completes.
- **This plan set** is the living source of truth during the refactor; fold the durable outcomes back into AGENTS.md at Phase 8.

---

## 3. Target Architecture

```
                          ┌─────────────────────────── PWA (client) ───────────────────────────┐
                          │  api.js speaks NORMALIZED endpoints + x-gym-id / active gym context │
                          │  gym selector · per-gym theme · capability-flag-driven UI           │
                          └───────────────────────────────┬─────────────────────────────────────┘
                                                          │  /api/timetable, /api/events/:id,
                                                          │  /api/book, /api/cancel, /api/waitlist,
                                                          │  /api/swap, /api/profile, /api/credits …
                          ┌───────────────────────────────▼─────────────────────────────────────┐
                          │                         Express BFF (server)                          │
                          │  routes → resolve gym (user_gyms / x-gym-id) → provider factory       │
                          │  scheduler · poller · calendar · notifications  (all gym-aware)       │
                          └───────────────────────────────┬─────────────────────────────────────┘
                                                          │  GymProvider interface (base.js)
                                    ┌──────────────────────┴───────────────────────┐
                                    ▼                                               ▼
                        ┌───────────────────────┐                     ┌───────────────────────────┐
                        │ providers/codexfit.js │                     │ providers/marianatek.js   │
                        │ direct login, Mon-noon│                     │ headless OAuth PKCE,       │
                        │ cancel-rebook swap    │                     │ per-class release, native  │
                        │ (extracted, unchanged)│                     │ swap_spots + waitlist      │
                        └───────────┬───────────┘                     └───────────────┬───────────┘
                                    ▼                                                 ▼
                          psycle.codexfit.com                              {tenant}.marianatek.com
```

**Data model (multi-gym):** `users` (account identity) → `user_gyms` (per-gym creds + session, priority, calendar_token) → per-user tables (`auto_bookings`, `auto_upgrades`, `studio_preferences`, `booking_cache`, `waitlist_cache`, `calendar_classes`, `settings`) all gain `gym_id` and dual-key uniqueness.

---

## 4. Phased Implementation Plan

> Each work package (WP) has an ID used in [PROGRESS.md](./PROGRESS.md). Dependencies in brackets. **AC** = acceptance criteria. Order within a phase is roughly dependency order; parallelizable WPs are noted.

### Phase 0 — Research completion (resolve MT unknowns)
Goal: eliminate the [§1F unknowns](../../Services/marianatek.md) that would block implementation, and capture real API fixtures.

- **WP-R1 — MT auth lifecycle.** Confirm refresh-token expiry behavior and the re-login-with-stored-creds fallback end-to-end on JAB test account. Document token TTLs. **AC:** a documented, repeatable headless-OAuth + refresh + fallback sequence; edge cases (expired refresh) noted.
- **WP-R2 — MT write-path validation.** On the test account, validate `POST /me/reservations` (with a bookable/affordable class or membership), `swap_spots`, `cancel_penalty` (read), `waitlist` join + `assign_to_spot`. **Do not cancel real paid bookings.** **AC:** each write path either confirmed working or documented as blocked with reason.
- **WP-R3 — Fixture capture.** Save real JSON responses (classes, class detail w/ layout, reservations, account, credits) as test fixtures under `server/__fixtures__/marianatek/`. **AC:** fixtures committed; field-mapping table (MT → NormalizedEvent/Slot) drafted.
- **WP-R4 — Rate limits & error taxonomy.** Probe for 429s under polling cadence; catalog MT error shapes (e.g. `non_field_errors`). **AC:** documented limits/guidance + error-normalization notes.

### Phase 1 — Provider abstraction (server, behavior-preserving) [after R3]
Goal: introduce the abstraction and extract CodexFit into an adapter with **zero behavior change**.

- **WP-A1 — Normalized shapes + base interface.** `server/providers/base.js` (JSDoc-typed `GymProvider`), `server/providers/normalize.js` (shape factories + validators). **AC:** interface documented; no runtime wiring yet.
- **WP-A2 — Gym registry + provider factory.** `server/gyms.config.js` (static registry: `psycle-london` → codexfit config; `jab-boxing` → marianatek config, disabled) + `server/providers/index.js` `getProvider(gymId)`. **AC:** factory returns correct adapter by gym id.
- **WP-A3 — Extract CodexFit adapter.** Move CodexFit fetch/header/auth/booking logic from `auth.js`, `server.js` proxy, `scheduler.js`, `poller.js`, `calendar.js` into `server/providers/codexfit.js` implementing the interface. **AC:** all provider-specific strings live in the adapter/config; callers use the interface.
- **WP-A4 — Route through adapter.** Wire proxy/auth/scheduler/poller/calendar to call the adapter. **AC:** **Psycle regression suite green; behavior identical** (WP-T3 harness). Merge to `modular`.

### Phase 2 — Multi-gym data model [after A2]
Goal: `gyms` + `user_gyms` and gym-scoped per-user tables, with a clean migration.

- **WP-D1 — Schema + migration.** Create `gyms`, `user_gyms`; migration backfills existing users → `gym_id='psycle-london'`, moving creds/session/calendar_token from `users` to `user_gyms`. **AC:** idempotent migration; existing users keep working after migrate.
- **WP-D2 — Gym-scope per-user tables.** Add `gym_id` to `auto_bookings`, `auto_upgrades`, `studio_preferences`, `booking_cache`, `waitlist_cache`, `calendar_classes`, `settings`; change uniqueness to include `gym_id`; spot maps keyed `(user,gym,studio)`. **AC:** migration + backfill; no cross-gym key collisions.
- **WP-D3 — Account bootstrap + gym linking.** First gym login creates the Sweat account + first `user_gyms` row; "link a gym" adds another. Local JWT = account; per-request active gym resolution. **AC:** a test account can link both a CodexFit and (stub) MT gym.
- **WP-D4 — db.js CRUD + admin gym-awareness.** Update all `db.js` queries for gym scoping; `admin.js` shows gyms per user. **AC:** admin panel lists linked gyms; queries scoped.

### Phase 3 — Normalized server API [after A4, D4]
Goal: the client stops speaking raw CodexFit.

- **WP-N1 — Normalized endpoints.** Add `/api/timetable`, `/api/events/:id`, `/api/book`, `/api/cancel`, `/api/waitlist`, `/api/swap`, `/api/profile`, `/api/credits`, `/api/config` (gyms + capabilities) backed by adapters. **AC:** endpoints return normalized shapes for CodexFit.
- **WP-N2 — Migrate Psycle client off `/api/proxy`.** Point `api.js` at normalized endpoints; keep a proxy shim during transition. **AC:** Psycle client works via normalized API; raw proxy usage removed or shimmed.
- **WP-N3 — Wire background services.** Scheduler/poller/calendar use adapter methods + normalized `releaseAt`. **AC:** auto-book/upgrade/calendar unchanged for Psycle via normalized path.

### Phase 4 — MarianaTek adapter [after A1, R-series]
Goal: implement the MT provider.

- **WP-M1 — MT auth.** Headless OAuth (PKCE) login + refresh ladder + re-login fallback; session bundle persistence. **AC:** JAB test account logs in server-side and stays authenticated across a simulated 7-day refresh.
- **WP-M2 — MT timetable + layout.** `fetchTimetable`, `fetchEventDetails` → NormalizedEvent/Slot incl. `pick-a-spot` and `first-come-first-serve`. **AC:** JAB timetable + floor plan render via normalized shapes (against fixtures + live).
- **WP-M3 — MT bookings.** `bookSlot`, `cancelBooking` (guarded), `joinWaitlist`/`leaveWaitlist`, `assign_to_spot`, native `swapSpots`. **AC:** validated on test account per WP-R2 constraints.
- **WP-M4 — MT profile/credits/capabilities.** `me/account`, `me/credits`, `me/memberships`, `getCancelPenalty`; declare `ProviderCapabilities` (no purchase, no bookmarks for JAB). **AC:** capability flags drive server responses.
- **WP-M5 — MT dev mock.** `mock-marianatek.js` + a JAB dev login path. **AC:** dev can browse/book JAB with no live MT calls.

### Phase 5 — Client refactor [after N1]
Goal: multi-gym, capability-aware, theming UI.

- **WP-C1 — Normalized api.js + gym context.** All calls carry active `gymId`; `x-gym-id` for public/pre-login. **AC:** every UI module reads normalized shapes only.
- **WP-C2 — Gym selector + switcher.** Onboarding "choose gym" + link-a-gym in Settings + persistent switcher. **AC:** switching gym re-scopes timetable/bookings/auto-book.

  > **Scope clarification (stakeholder, 2026-08-31): one Sweat Assistant login, many gym accounts.** The end state is a single SA identity that holds *N* gym credentials, not one SA account per gym. Today an SA login **is** a gym login — `users.email`/`users.encrypted_password` are the CodexFit credentials, so the SA identity and the gym credential are the same thing. Phase 2 already built most of what's needed and it is **not** blocked on new schema:
  >   - ✅ `user_gyms` exists and is already the source of truth for per-gym auth/session/priority/calendar-token/profile (WP-D3).
  >   - ✅ `db.linkGym()` exists — built for D3's acceptance criteria but **never routed to an endpoint**.
  >   - ⬜ `resolveActiveGymId()` is still the D3 stub that always returns `psycle-london`; the client already sends `x-gym-id` (WP-C1) and nothing reads it.
  >   - ⬜ No SA-native identity separate from a gym credential, so "log in to Sweat Assistant, then add JAB" has no first step yet.
  >   - ⬜ No add-a-gym flow (authenticate against gym #2 → `linkGym()` → appears in the switcher).
  >
  > Sequence that falls out: route `linkGym()` → make `resolveActiveGymId()` read `x-gym-id` (and validate the user is linked to it) → add-a-gym UI → switcher. The SA-native-identity question (does the SA account get its own email/password, or does the first linked gym remain the identity?) is a **real decision to make before the add-a-gym flow**, not an implementation detail — a user who cancels their Psycle membership shouldn't lose their JAB access.
- **WP-C3 — Per-gym theming.** Inject gym theme tokens; compose with light/dark; no flash. **AC:** JAB navy vs Psycle violet correct on switch.
- **WP-C4 — Capability-flag UI.** Hide/disable credits (JAB) + bookmarks (MT) via flags. **AC:** no dead buttons for unsupported features.
- **WP-C5 — Floor-plan renderers.** `spotmap.js` + `timetable.js` renderers consume normalized slots (both layout formats); FCFS shows no picker; consolidate the two renderers where feasible (see [[two-floor-plan-renderers]]). **AC:** both providers' layouts render + preferred-spot save works.
- **WP-C6 — Booking-window generalization.** `lib.js` release/countdown reads normalized `releaseAt` per event (per-class for MT). **AC:** correct countdowns for both providers.

### Phase 6 — Scheduler / poller generalization [after M3, N3]
Goal: background automation works for both providers.

- **WP-S1 — Auto-book on normalized releaseAt.** Precision timer arms off per-event `releaseAt` (per-class MT vs Monday-noon CF). **AC:** auto-book fires at the right instant for a JAB class.
- **WP-S2 — Auto-upgrade via adapter swap.** Native `swap_spots` for MT, cancel-rebook for CF; respect MT native auto-fill (no double-action). **AC:** JAB spot upgrade via swap validated on test account.
- **WP-S3 — Gym-aware dispatch/quotas.** Priority tiers, `claimedSlots`/`burnedSlots` keyed by gym, quotas per gym. **AC:** concurrent multi-gym dispatch has no cross-gym interference.

### Phase 7 — Testing & rollout
- **WP-T1 — Adapter unit tests** (fixtures, both providers). **AC:** normalization covered by tests.
- **WP-T2 — JAB integration suite** (test account, guarded writes). **AC:** end-to-end JAB booking flow passes.
- **WP-T3 — Psycle regression suite** (used from Phase 1 onward). **AC:** parity checks green at every phase boundary.
- **WP-T4 — Staged rollout.** `gym.enabled` flag; enable JAB per-account; monitor. **AC:** JAB live for pilot account; Psycle unaffected.

### Phase 8 — Documentation & cleanup
- **WP-X1 — Docs.** Update AGENTS.md (Providers section, schema, routes), add `adding-a-provider.md`, resolve marianatek.md §1F, update BACKLOG. **AC:** docs reflect shipped architecture; this plan set marked complete.

---

## 5. Testing Strategy

1. **Psycle regression harness (WP-T3) first.** Before extracting anything (Phase 1), capture golden outputs for the Psycle flows (timetable parse, booking payload shape, release-time math, calendar .ics). Every phase boundary re-runs it. This is the safety net for the whole refactor.
2. **Fixture-based adapter unit tests.** Real captured JSON (WP-R3) → normalization assertions. Deterministic, no network.
3. **Guarded live integration (JAB).** Only the authorized test account; write operations behind an explicit `ALLOW_LIVE_WRITES` guard; **never cancel real paid bookings**.
4. **Dev-mode mocks.** `mock.js` (CodexFit) + `mock-marianatek.js` (MT) let the full UI run offline for both providers.
5. **Manual verification.** Use `/run` + `/verify` skills to drive the real PWA for gym switch, theming, floor plan, capability-flag UI. Clear the service worker after deploy ([[prod-deploy-cache-gotcha]]).

---

## 6. Risks & Mitigations

| Risk | Severity | Mitigation |
|------|----------|-----------|
| CodexFit disentangling regresses Psycle | High | Behavior-preserving extraction (Phase 1) + regression harness (WP-T3) run at every boundary. |
| Client `/api/proxy` raw-path coupling is deeper than expected | High | Phase 3 compatibility shim allows incremental migration; audit all `proxyGet/Post/Put/Delete` callers first. |
| MT refresh token expires between Mondays → silent auto-book failure | Med | Credential ladder re-runs headless OAuth with stored creds; push-notify on hard failure; WP-R1 confirms TTLs. |
| ID collisions across providers corrupt caches/maps | Med | Dual-key `(user, gym, …)` everywhere; migration adds `gym_id` before any MT data lands. |
| MT native waitlist auto-fill conflicts with our auto-upgrade | Med | WP-S2 respects native behavior; scope our MT automation to `swap_spots` quality, not promotion. |
| Purchases unshippable for JAB | Low (accepted, D3) | Capability flag hides purchase UI; documented as de-scoped. |
| Bookmarks have no MT API | Low (accepted) | Capability flag; graceful "unsupported" state. |
| Multi-agent merge conflicts on big files | Med | WP-scoped branches; PROGRESS.md ownership + handoff protocol; touch-list per WP. |

---

## 7. Open Questions (track in [PROGRESS.md](./PROGRESS.md#open-questions--blockers))

- MT refresh-token hard expiry (30/60/90d?) — WP-R1.
- MT credit/membership **purchase** API for non-JAB studios (Barry's) — deferred (D3).
- MT cart endpoint auth requirement (session vs bearer) — WP-R2/R4.
- Merged "All gyms" timetable view — stretch, decide during WP-C2.
- Whether to keep `/api/proxy` shim long-term or fully remove — decide end of Phase 5.

---

## 8. File Impact Map (for planning touch-lists)

| File | Change |
|------|--------|
| `server/auth.js` | Extract login/relogin into CodexFit adapter; account-vs-gym session split. |
| `server/server.js` | Proxy → provider factory; add normalized endpoints; gym resolution middleware. |
| `server/scheduler.js` | Release timing on normalized `releaseAt`; adapter booking; gym-keyed coordination. |
| `server/poller.js` | Adapter swap/upgrade; MT native auto-fill awareness. |
| `server/calendar.js` | Adapter-sourced bookings; per-gym calendar_token. |
| `server/db.js` | `gyms`, `user_gyms`, `gym_id` columns, migrations, gym-scoped CRUD. |
| `server/admin.js` | Gym-aware user detail. |
| `server/config.js` + new `server/gyms.config.js` | Gym registry. |
| `server/providers/*` (new) | `base.js`, `normalize.js`, `index.js`, `codexfit.js`, `marianatek.js`. |
| `server/mock.js` + new `mock-marianatek.js` | Per-provider mocks. |
| `client/src/api.js` | Normalized endpoints; gym context. |
| `client/src/lib.js` | Generalized release/countdown. |
| `client/src/ui/timetable.js`, `bookings.js`, `credits.js`, `settings.js`, `onboarding.js`, `spotmap.js` | Normalized shapes, gym switcher, theming, capability flags, floor-plan parsing. |
| `client/public/manifest.json`, `app.config.json` | "Sweat Assistant" branding. |
| `Documentation/*` | Per §2.5. |

---

_See [PROGRESS.md](./PROGRESS.md) for live status and [AGENT_INSTRUCTIONS.md](./AGENT_INSTRUCTIONS.md) for the multi-agent working protocol._
