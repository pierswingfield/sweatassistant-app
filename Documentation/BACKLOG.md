# Sweat Assistant — Project Backlog

This document tracks **open** feature requests, bugs, technical debt, and future architectural tasks.

Finished work is archived in [Backlog/COMPLETED.md](file:///Users/pierswingfield/Desktop/AI%20Projects/psycle%20chrome/App/Documentation/Backlog/COMPLETED.md) — this file is loaded into agent context every session, so it is kept short on purpose. Move items there when they are done rather than growing a completed section here.

---

## 1. Deferred Immediate Fixes

### Gym setup step in signup / onboarding (Multi-Gym Sequential Linking)
* **Status**: ❌ Open
* **Why**: signup now creates a Sweat Assistant account with no gym attached (Decision D4), so a new user lands in an app that can't show them anything. There is a stopgap "Connect a gym" screen, but it sits outside the 6-step first-run onboarding flow in [onboarding.js](file:///Users/pierswingfield/Desktop/AI%20Projects/psycle%20chrome/App/client/src/ui/onboarding.js) rather than being part of it.
* **What**: add a **gym setup step** to onboarding — pick a gym from the enabled catalogue, sign in with that gym's credentials, confirm it linked, and **allow linking multiple gyms in a row** (with an "Add another gym" option before continuing to the app) rather than forcing the user into Settings later. Enforce **maximum of one per-gym account per Sweat Assistant account**. Positioned after account creation and before notifications/calendar/spot-maps. Existing onboarding is `intro → install → login → notifs → calendar → spot maps`; the new shape is `intro → install → account → **connect gym(s)** → notifs → calendar → spot maps`.
* **Notes**: the onboarding flow is resumable via `psycleOnboardingStep` (iOS relaunches after Add to Home Screen), so the new step needs to survive that. Should also handle "linked a gym that then failed" and offer to retry rather than dead-ending.

### Active Bookings & Auto-Upgrade for MarianaTek (Bug)
* **Status**: ❌ Open
* **Why**: Live test (2026-09-02) revealed that successfully booked JAB classes do not appear in **My Bookings > Active Bookings**, and spot-upgrade chips cannot attach.
* **Root Cause**: `bookings.js` line 58 (`toLegacy`) and line 138 check raw CodexFit `event.start_at`, `event.event_type.name`, etc. MarianaTek reservations use `start_datetime`, `class_type`, etc., so `if (!event || !event.start_at) return;` silently discards all MarianaTek bookings.
* **Fix**: Migrate `bookings.js` to consume `NormalizedEvent` fields (`startAt`, `name`, `discipline`, `instructors`, `locationName`, `studioName`) directly, matching the WP-D15 timetable migration.

### Timetable Pagination for MarianaTek (Bug)
* **Status**: ❌ Open
* **Why**: Only a few days of classes are visible in the timetable for JAB.
* **Root Cause**: `providers/marianatek.js fetchTimetable()` requests single page (`page_size=100`) without following `links.next` pagination. Across multiple studios/days, 100 classes only covers ~3–5 days.
* **Fix**: Follow MarianaTek `data.links.next` / pagination loop in `fetchTimetable()` until the requested `endDate` range is satisfied.

### Unified Parallel Multi-Gym Views (Architecture / Workstream P1)
* **Status**: ❌ Open (refined 2026-09-02)
* **Summary**: Eliminate active-gym switching as the primary UX. Instead, **show all linked gyms together**:
  - **Timetable**: Aggregated parallel class list across all linked gyms, with a gym filter alongside location/instructor/type filters.
  - **Auto-Book Queue**: Combined queue across all linked gyms.
  - **My Bookings**: Combined active bookings & waitlists across all linked gyms.
  - **Buy Credits Tab**: Permanently visible when multiple gyms are linked, with a submenu/dropdown to select which gym to buy credits for (only displaying gyms where `creditPurchase: true`, e.g. Psycle London enabled, JAB Boxing hidden).

### Account recovery — self-service mechanism (admin reset is the interim)
* **Status**: 🟡 Admin reset built 2026-08-31. **No self-service reset** — mechanism still to be chosen.
* **Interim, shipped**: `POST /api/admin/users/:id/reset-password` + a button in the admin panel. The server generates a strong temporary password and returns it **once** for the admin to relay out-of-band; the admin never chooses it and it cannot be read back. Clears stored gym credentials by default (opt-out checkbox for a routine forgotten password) — per Decision D5, an account that needed recovering is not assumed safe. Links, queues, spot maps and priority tiers survive; the user re-authenticates each gym.
* **Why gym-login recovery is not an option**: it was built and removed the same day (Decision D5). It re-coupled the account to the gym — cancel the membership and you can't recover — and silently promoted the gym password to a permanent master key for the Sweat Assistant account, inheriting the gym's password rules and security posture. **Do not reintroduce it.**

**What Cloudflare Access actually is here** (checked against the live config, 2026-08-31 — re-verify before relying on it):
* **Zero identity providers are configured**, so Access falls back to its built-in **One-Time PIN emailed to the address you type**. Access, in this deployment, *is* an email-verification service you already run.
* `*.wingfield.tech` catch-all (covers `sweat` and `sweat-dev`) → allow **`piers@piersj.com` only**.
* `psycle.wingfield.tech` → its own app → allow **Everyone** (still OTP-authenticates, any address).
* `psycle.wingfield.tech/api/calendar/*` → **bypass**, so native calendar clients can fetch the `.ics`. **No Access identity on that path.**
* Both hostnames serve the same prod container. Prod currently has **3 accounts**.

**Candidates:**
1. **Cloudflare Access identity** — verify the Cloudflare-signed `Cf-Access-Jwt-Assertion` against the team JWKS, pin the `aud` to this app, and allow a reset when the token's email matches the account. No dependency, no mail server, no stored secret. Sound because an attacker can only obtain a token for an address they can receive a PIN at. **Footgun**: you must verify the *signed JWT*, never the plaintext `Cf-Access-Authenticated-User-Email` header — anyone hitting the bypassed `/api/calendar/*` path can set that header by hand. Caveats: `sweat.wingfield.tech` admits only one email today, so other accounts would need adding to the policy or would have to use `psycle.wingfield.tech`; and it ties recovery to Access staying in front of the app. **~half a day.**
2. **Email reset link** — the universal mechanism, and the only one that survives Access being removed. Needs an SMTP credential and deliverability care; this deployment sends no mail at all today. Largely duplicates what Access is already doing. **~a day, plus an ongoing account.**
3. **Recovery codes** — single-use codes issued at signup, hashed at rest. Zero infrastructure and strong, but front-loads friction and people lose them. Best as a secondary factor, not the only route. **~2 hours.**
4. **Passkeys** — replaces the password entirely, syncs via iCloud/Google keychains, and is itself a recovery factor (it would also close the zero-gym hole). Needs `@simplewebauthn/server` + `/browser`; hand-rolling WebAuthn means CBOR, COSE, attestation and signature verification, which is a security project in itself. **1–2 days.**

* **Recommendation**: (1) Access identity when self-service is wanted, with the admin reset staying as the backstop. Skip (2) unless the user base grows beyond people you'd add to a policy. Treat (4) as its own piece of work rather than a recovery mechanism.
* **Settled regardless of choice**: a successful recovery resets **all** stored gym credentials via `db.resetGymCredentials()`.

### Account setup — remaining gaps
* **Status**: 🟡 Core built 2026-08-31. **Not yet browser-click-verified.**
* **The agreed shape** (stakeholder): account setup is **email + password**; gym authentication is **added afterwards as separate logins**.
* **Built**: `POST /api/auth/signup` (gym-independent), three-mode auth screen (sign in / create account / reset password), a "Connect a gym" screen for accounts with none, and **409 `NO_GYM_LINKED`** on gym-scoped routes so a gym-less account isn't sent round a 401 login loop.
* **Remaining**:
  1. **Legacy accounts with a gym password under 8 characters never migrate.** `setAccountPassword` enforces the minimum; seeding fails (caught, logged, login still succeeds) and the account stays gym-coupled forever. Needs a one-time "set your Sweat Assistant password" prompt, or an explicit decision to leave them.
  2. **No migration observability.** Nothing reports how many accounts have an SA password; the admin panel shows linked gyms but not `password_hash IS NULL`. Cheapest item here, and it sizes the rest.
  3. **`users.email` doubles as the SA username and has no way to change it.** The *divergence* half is fixed — `user_gyms.gym_email` (WP-D5) holds each gym's own login, and NULL there means "re-link needed", never "fall back to `users.email`". What remains is letting someone change their Sweat Assistant email.
* **Related tech debt**: `users.encrypted_password` is `NOT NULL` but vestigial since WP-D3. `createAccount` writes `''` and `mergeUserWithGym` coerces empty → null so nothing mistakes it for a credential. Dropping it means rebuilding `users`, which ~10 tables cascade-reference — fold into a future `users` migration rather than doing it alone.

## 2. Advanced Backlog Items

### In-App 3-D Secure Support
* **Status**: ❌ Open (partial)
* **Spec Link**: [3d_secure_checkout.md](file:///Users/pierswingfield/Desktop/AI%20Projects/psycle%20chrome/App/Documentation/Backlog/3d_secure_checkout.md)
* **Summary**: Embed Stripe.js in the PWA client to complete the 3DS verification modal in-app for credit purchases, rather than bouncing users to the external Shopify site checkout.

### Sweat Assistant Multi-Gym Architecture
* **Status**: 🟡 **6 of 8 asymmetry layers closed** (2026-09-02). A JAB user can now load the app and browse a real MarianaTek timetable, browser-verified. **Two items left: gym-keyed runtime state (~half a day) and a live JAB booking (blocked on a funded account).**
* **What blocks turning JAB on**: [modular-gyms/OUTSTANDING.md](file:///Users/pierswingfield/Desktop/AI%20Projects/psycle%20chrome/App/Documentation/Backlog/modular-gyms/OUTSTANDING.md) — answers it in one read. **Start here.**
* **Live status board**: [modular-gyms/PROGRESS.md](file:///Users/pierswingfield/Desktop/AI%20Projects/psycle%20chrome/App/Documentation/Backlog/modular-gyms/PROGRESS.md) — per-work-package detail.
* **The goal, stated precisely** (stakeholder, 2026-08-31): this is **not** bolting MarianaTek onto CodexFit as an extension. Every gym is an equal upstream service. Three layers: **platform module** (`providers/*.js` — the protocol, shared by every tenant on that platform), **gym config** (`gyms.config.js` — the instance and its policy), **app** (everything else — normalized types and capability flags only). MarianaTek is a platform many gyms use, JAB being one; so is CodexFit, Psycle being one.
* **The acceptance test**: delete `psycle-london` from `gyms.config.js` and nothing outside `providers/codexfit.js` should break. Corollary: **a third gym should need zero edits outside `providers/` and `gyms.config.js`.** Enforced by `server/test-no-gym-privilege.js`.
* **Closed**: C (gym link identity), A (data layer refuses to guess), B (no module-level providers), E (booking window: protocol vs policy), D (client fully on normalized types), F (capability-gated UI + per-gym theming).
* **Open**: G (gym-keyed runtime state — dispatch sets, quota constant, client cache prefix), H (**no live MarianaTek booking has ever succeeded** — needs a funded JAB account; the one item code cannot close).
* **Summary**: Refactor the backend proxy, auth, database and client to support both CodexFit and Mariana Tek under one codebase. Decisions locked: multi-gym-per-account, "Sweat Assistant" brand, full parity minus purchases, and (D4) the Sweat Assistant account has its own identity.

### Single Sweat Assistant Login, Multiple Per-Gym Accounts
* **Status**: ✅ Built 2026-08-31 (WP-C2), extended by WP-D5 (`user_gyms.gym_email`). Server resolution, SA-native identity, link/unlink/re-auth, signup and the Settings UI are all in. **The gym-switcher UI is still not browser-click-verified** — the 2026-09-01 smoke test covered the timetable and auto-book paths, not gym switching.
* Remaining follow-ups live in *Account setup & recovery* above and in [modular-gyms/OUTSTANDING.md](file:///Users/pierswingfield/Desktop/AI%20Projects/psycle%20chrome/App/Documentation/Backlog/modular-gyms/OUTSTANDING.md).

### CodexFit 429/403 Distress Abort (Tech Debt)
* **Status**: ❌ Open
* **Summary**: Detect when CodexFit begins returning HTTP 429 or 403 blocks during landrush booking execution. In state of distress, abort the remaining queue to protect the server's egress IP and push-notify users.

### Track Relogin Failures per User (Observability)
* **Status**: ❌ Open
* **Summary**: Add database fields to track credential failures during automatic relogins. Proactively flag broken credentials on the Admin Dashboard before Monday release runs.

### SQLite Database Backup Mechanism (DevOps)
* **Status**: ❌ Open
* **Summary**: Set up a background cron backup task on the Pi to back up the SQLite database to a local file volume and prune snapshots older than 14 days.

### Per-User Key Derivation (Security)
* **Status**: ❌ Open
* **Summary**: Derive individual AES encryption keys for each user using HKDF, combining the system master key with unique user-record salts.

### PostgreSQL Migration (Scale)
* **Status**: ❌ Open
* **Summary**: Transition database storage from `better-sqlite3` to PostgreSQL to improve concurrent write performance and simplify database orchestration in production.

### Competing Booking Detection & Conflict Warning (UX)
* **Status**: ❌ Open
* **Summary**: Analyze the scheduler queue to detect when multiple users are targeting the identical slot of a class, and warn them in-app so they can select a fallback option.

### Structured Logging & Metrics (Telemetry)
* **Status**: ❌ Open
* **Summary**: Replace standard `console.log` statements with structured JSON logging and expose a Prometheus metrics endpoint to monitor success rates and API latencies.

---
