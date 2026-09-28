# AGENTS.md — Psycle PWA

## What This Is

Server + PWA assistant for Psycle London (and future gym providers). It moves scheduling features (auto-book, auto-upgrade) to a background server so they run 24/7 and adds iOS support via Progressive Web App (PWA) and Web Push notifications.

**Status**: Prod (`sweat.wingfield.tech`) runs the old single-gym `master` build. The
multi-gym `modular` branch (Psycle + JAB Boxing) is committed and running on the dev twin
(`sweat-dev.wingfield.tech`), but is **not yet promoted to prod**. See workstream C4 before
changing or deploying it.
As of 2026-09-28, the dev twin runs `modular` with C1–C3, C5-1/3, U1, C7-1/2 and the pulled-forward C2-6/C6-4/U2-3 (see `Documentation/Workstreams/`). C4 Stage A is mostly passed; Stage B (promote to prod) is unblocked now that the C1-5 backups exist.

## Key References

- [Workstreams/AGENT_PROTOCOL.md](file:///Users/pierswingfield/Desktop/AI%20Projects/psycle%20chrome/App/Documentation/Workstreams/AGENT_PROTOCOL.md) — **Mandatory before working any item**: verify first (code plus real browser), then change, then re-verify.
- [Workstreams/README.md](file:///Users/pierswingfield/Desktop/AI%20Projects/psycle%20chrome/App/Documentation/Workstreams/README.md) — **The roadmap and single source of truth for what's next**: workstreams, priority order, dependencies, open decisions.
- [DESIGN.md](file:///Users/pierswingfield/Desktop/AI%20Projects/psycle%20chrome/App/Documentation/DESIGN.md) — Design and UI guidelines.
- [psycle_codexfit.md](file:///Users/pierswingfield/Desktop/AI%20Projects/psycle%20chrome/App/Documentation/Services/psycle_codexfit.md) — CodexFit/Psycle API integration and native website timetable behavior.
- [marianatek.md](file:///Users/pierswingfield/Desktop/AI%20Projects/psycle%20chrome/App/Documentation/Services/marianatek.md) — Mariana Tek provider platform research and integration notes.
- [TESTING.md](file:///Users/pierswingfield/Desktop/AI%20Projects/psycle%20chrome/App/Documentation/TESTING.md) — **`npm test` runs everything.** Three layers (server suites, client vitest units, browser smoke via Claude for Chrome) and what each can and cannot catch. Read before adding a test.
- [LIVE_VERIFICATION_PLAYBOOK.md](file:///Users/pierswingfield/Desktop/AI%20Projects/psycle%20chrome/App/Documentation/LIVE_VERIFICATION_PLAYBOOK.md) — Risk-tiered rules for any check against a live gym API.
- [QA/USER_FLOW_VALIDATION_PLAN.md](file:///Users/pierswingfield/Desktop/AI%20Projects/psycle%20chrome/App/Documentation/QA/USER_FLOW_VALIDATION_PLAN.md) — Browser user-flow validation matrix; run results live in `QA/browser-runs/`.
- [Workstreams/C4-live-acceptance-and-launch.md](file:///Users/pierswingfield/Desktop/AI%20Projects/psycle%20chrome/App/Documentation/Workstreams/C4-live-acceptance-and-launch.md) — **What blocks promoting `modular` and enabling JAB Boxing.**
- [Archive/2026-09-26/](file:///Users/pierswingfield/Desktop/AI%20Projects/psycle%20chrome/App/Documentation/Archive/2026-09-26/) — Frozen pre-2026-09-26 backlog, specs and modular-gyms decision log (PLAN/PROGRESS/FINDINGS). **Status there is stale**; read only for design detail and "why is it like this?".

## Backlog Management Process

1. Status lives **only** in `Documentation/Workstreams/`: one file per workstream (C1–C7 core, U1–U3 UX, F future), with the order and dependency map in its README.
2. Item IDs (`C3-4`, `U1-2`) are stable. Use them in commits and code comments.
3. For a large design, write a spec file in `Workstreams/` and link it from the item. Never revive archived files.

## Subagent Execution Rules

- **Verify first.** Before changing code for any backlog item, confirm the basis of the bug or change in the code **and**, for anything user-visible, **in a real browser**. For server-only items, use a failing test or a request. Record the evidence. See [Workstreams/AGENT_PROTOCOL.md](file:///Users/pierswingfield/Desktop/AI%20Projects/psycle%20chrome/App/Documentation/Workstreams/AGENT_PROTOCOL.md).
- **Real browser = the user's Google Chrome**: CDP on `127.0.0.1:9222` (any agent), or the Claude for Chrome extension (native Claude agents; installed and signed in). If neither is reachable, **stop and report `BLOCKED: no real-browser access`**. jsdom, curl and fresh headless browsers are not substitutes.
- **Gemini offload wherever possible** (`gemini-delegate`, `Model: 'flash'`; never `pro` or `inherit`) for reading, summarising, triage and locating code. Gemini has **no browser tools**, so browser verification and code edits need an agent that has them.

---

## Project Structure

```
App/
├── server/                  # Express.js backend
│   ├── server.js            # Main server — routes, proxy, cart/checkout, SSE, rate limiters
│   ├── auth.js              # CodexFit login, JWT issuance, auto-relogin on 401
│   ├── db.js                # SQLite schema + CRUD (better-sqlite3, 15 tables)
│   ├── crypto.js            # AES-256-GCM encrypt/decrypt for credentials (env key required)
│   ├── scheduler.js         # Auto-book precision scheduler — queue-driven wake clock
│   │                        #   (WP-I), priority tiers, SSE
│   ├── poller.js            # Auto-upgrade polling + cancellation/window reminders + cache refresh
│   ├── push.js              # Web Push (VAPID) notification fan-out service
│   ├── notifications.js     # Notification dispatch layer (5 types, per-user prefs)
│   ├── calendar.js          # iCalendar (.ics) feed generation, token auth, 3-hourly poll
│   ├── admin.js             # Admin panel API router (user list, detail, priority tiers, delete)
│   ├── admin.html           # Standalone admin SPA served at /admin
│   ├── config.js            # Central env config (appName, publicHost) — single source of truth
│   ├── gyms.config.js       # ★ Gym registry — the single source of gym truth (URLs,
│   │                        #   headers, theme, capabilities, booking-window POLICY)
│   ├── routes-normalized.js # Gym-agnostic API surface (/api/timetable, /api/metadata,
│   │                        #   /api/book, …) — what the client should use
│   ├── providers/           # ★ Platform adapters — the ONLY gym-aware code
│   │   ├── base.js          #   GymProvider contract + Normalized* typedefs
│   │   ├── index.js         #   getProvider(gymId) → an adapter instance
│   │   ├── normalize.js     #   makeEvent/makeSlot/makeMetadata/… shape builders
│   │   ├── booking-window.js#   Policy evaluator (platform- AND gym-agnostic)
│   │   ├── codexfit.js      #   CodexFit protocol (Psycle's platform)
│   │   └── marianatek.js    #   MarianaTek protocol (JAB's platform)
│   ├── mock.js              # Dev-mode mock CodexFit API (dev@psycle.com)
│   ├── mock-marianatek.js   # Dev-mode mock MarianaTek API (dev@jabboxing.mock)
│   ├── schedule-cache.js    # ★ Shared user-agnostic provider cache (SWR + single-flight)
│   ├── rate-limit-backoff.js # ★ Per-gym provider 429 backoff, shared by scheduler.js AND poller.js (C2-3/C2-3b)
│   ├── run-tests.js         # Test runner — discovers server/test-*.js by filename
│   └── test-*.js            # 47 suites; see Documentation/TESTING.md
├── client/                  # Vite PWA frontend
│   ├── index.html           # SPA shell with 5 tab panels + modals + iOS bottom nav
│   ├── src/
│   │   ├── main.js          # App init, auth, tab routing, push, theme, offline, pull-to-refresh, credit badge
│   │   ├── api.js           # API abstraction layer (all server calls)
│   │   ├── lib.js           # Shared utilities (Luxon timezone, countdown, release time, booking-window detect)
│   │   ├── cache.js         # IndexedDB v2 wrapper (cache + api-responses stores);
│   │   │                    #   per-user key prefix + accountScopedKey() (C3-24 removed gymScopedKey)
│   │   ├── config.js        # Build-time + runtime app config (appName, publicHost via /api/config)
│   │   ├── styles.css       # Design tokens, light/dark parity (~7300 lines) — the only stylesheet loaded
│   │   ├── lib.test.js      # Client unit tests (vitest) — see Documentation/TESTING.md
│   │   ├── cache.test.js    # Gym-scoped cache-key isolation (WP-G)
│   │   ├── gym-context.js   # ★ Active gym's capabilities/theme/labels — what the UI gates on
│   │   ├── gym-context.test.js
│   │   └── ui/
│   │       ├── timetable.js   # Class timetable, filters, booking modal, quick-book, floor plan, mobile cards
│   │       ├── bookings.js    # My Bookings + Waitlists + Auto-Upgrade setup + edit-spots modal
│   │       ├── autobook.js    # Auto-Book queue, countdown, SSE stream, favourites, edit modal
│   │       ├── autoupgrade.js # Auto-Upgrade monitor list (rendered in Auto-Book tab)
│   │       ├── credits.js     # Buy Credits bundle cards, filters, in-app cart + Stripe checkout
│   │       ├── settings.js    # Account / Your Gyms / About coordination + gym drawer actions
│   │       ├── gym-settings-section.js # Shared explicit-gym settings renderer
│   │       ├── loading-skeleton.js # Shared timetable/card loading placeholders
│   │       ├── status-line.js # Polite aria-live status region for the Auto-Book SSE line (U2-3)
│   │       ├── spotmap.js     # Shared studio floor-plan editor (reused by bookings/timetable/settings/autobook/upgrade)
│   │       ├── tooltips.js    # Instructor + occupancy tooltips (hover + touch tap-to-toggle)
│   │       ├── onboarding.js  # First-run 6-step guided flow (intro → install → login → notifs → calendar → spot maps)
│   │       ├── pulltorefresh.js # Reusable pull-to-refresh for scroll containers
│   │       ├── credit-allowance.js # ★ The ONLY credit arithmetic — Infinity when unmetered
│   │       ├── credit-allowance.test.js
│   │       └── cards.js       # Shared SVG icons, discipline tags, gym BRAND assets
│   │                          #   (gymBrand/gymChip/renderGymRail), cleanClassName,
│   │                          #   shortSlotLabels, escapeHtml
│   └── public/
│       ├── manifest.json    # PWA manifest (name: "Sweat Assistant", standalone, portrait)
│       ├── sw.js             # Service worker (push + offline cache, network-first shell, cache-first assets)
│       └── icons/            # App icons (128, 192, 512 — any + maskable)
├── Dockerfile               # Multi-stage build (client → server/public)
├── docker-compose.yml       # Single-container deployment (port 3005→3000)
├── deploy.sh                # oracle deploy: rsync + docker compose up -d --build (dev twin by default; --prod needs a typed confirmation; --print dry-runs)
└── package.json             # Root workspace (concurrently dev server + client)
```

## Dev Commands

```bash
npm run install:all          # Install all dependencies
npm run dev                  # Start server + client concurrently (dev mode)
npm run dev:server           # Start server only (port 3000)
npm run dev:client           # Start Vite dev server only (port 5173, proxies /api)
npm run build:client         # Production build of client
npm start                    # Production start (server serves built client)

npm test                     # EVERYTHING: 47 server suites + the client Vitest suite
npm run test:server          # Server only
npm run test:client          # Client only (vitest)
```

See [TESTING.md](file:///Users/pierswingfield/Desktop/AI%20Projects/psycle%20chrome/App/Documentation/TESTING.md)
for the three testing layers and what each can and cannot catch. A browser smoke test is the
third layer and is **not** covered by `npm test` — run it before deploying client changes.

Server runs on port 3000. Vite dev server proxies `/api` to `localhost:3000`.

**Dev mode**: two mock gyms, one per platform.
- `dev@psycle.com` (any password) → `mock.js`, the CodexFit mock: 4 locations, 4 studios, 28 classes, 3 bundles. No mock for booking/waitlist/cancel actions.
- `dev@jabboxing.mock` → `mock-marianatek.js`, the MarianaTek mock, reached via `linkGymAccount`. Unlike the CodexFit mock it **does** cover the write paths (book/cancel/waitlist/swap), because the live JAB test account has no credits to exercise them with.

## Critical CodexFit API Gotchas

- **No token refresh endpoint exists.** When the JWT expires, the only option is re-auth via `POST /auth/login` or `POST /auth/multipass/login`. The server handles this automatically via `triggerAutoRelogin()`.
- **Direct login** (`POST /api/v1/customer/auth/login` with `{ email, password }`) works but is not used by the website (which uses Shopify multipass SSO). This is the key enabler for the PWA.
- **Required headers** on all CodexFit requests: `origin: https://psyclelondon.com`, `referer: https://psyclelondon.com/`, `accept: application/json`, `x-organisation: [object Object]` (yes, literally the string `[object Object]`).
- **Booking window**: Rolling Monday 12:00 PM London time release. `booking_cutoff` and `extended_cutoff` fields on user profile control access. `is_always_bookable` bypasses cutoffs.
- **No advanced-booking credits (2026-09-01)**: Psycle no longer issues them. The window is the 15-day base plus the member tier's extra days, and **the tier's extra days already arrive on the profile cutoff**, so no tier table exists anywhere in the code — encoding one would be a second source of truth that drifts the moment Psycle changes a tier. The old 15-day credit floor is removed from `providers/booking-window.js` entirely. **Any future per-gym window adjustment belongs in that gym's adapter** (`codexfit.js resolveBookingWindow` is the seam), never back in the shared evaluator, where it looked platform-neutral while encoding one gym's promotion.
- **Booking offset (Psycle)**: Standard window is **15 days** from the release Monday. The cutoff always lands on a **Tuesday** — booking for any given Tuesday opens on the Monday, so `releaseMonday + 15` (M+14 would be a Monday). The retired 8-day base had the same alignment (M+8 is also a Tuesday). *Corrected 2026-09-01: a brief 14 would have held Tuesday classes back a whole extra week for standard-tier members.* Membership tiers extend it by **days, not weeks**: Psycle 10 +2, Psycle 15 +3, Unlimited +8 — confirmed with a member 2026-08-31. **Never snap a window to a whole-week tier** — that was the pre-2026-08-31 model and it mis-computed 3 of the 4 current tiers in both directions. **Auto-detected** per user from profile `booking_cutoff`/`extended_cutoff` + `extended_booking_allowed`, used verbatim (clamped 1–35 days), so the base only bites on a cold start. The **extended-booking credit floor of 15 days is now a no-op** for standard members (it equals the base) — it dates from when the base was 8 and needs validating against a real account holding one. All of this is **policy and lives in `gyms.config.js → psycle-london.bookingWindow`**, not in `providers/codexfit.js` (WP-D8). `server/test-booking-window-policy.js` pins the Tuesday alignment and 10,000+ equivalence cases.
- **Bookmark identifier formula**: `studioId + "0000" + dayOfWeek + "0000" + HHmm` (e.g., studio 138, Monday 19:30 → `"1380000100001930"`).
- **Cart API (CodexFit v2, implemented 2026-09-26 as C2-1)**: in-app checkout uses the v2 cart at `https://psycle.codexfit.com/api/customer/v2` (`gyms.config.js → v2ApiBaseUrl`). The protocol is in `server/providers/codexfit-cart.js` plus the `CodexFitProvider` cart methods. The routes (`POST /api/cart/checkout/init/:bundleId` → `/confirm`) live in `routes-normalized.js`, gated on `creditPurchase`. The legacy v1 endpoints are gone, and `server/test-retired-endpoint-scan.js` fails if `/cart/add_bundle`, `get_payment_methods` or `ajaxCheckoutProcess` reappears. Facts from the live capture (`server/fixtures/codexfit-v2/PARITY.md`):
  - The add-line body has **no `quantity`**.
  - An untouched cart has **no `stripe` key**; the PaymentIntent appears only once a line exists.
  - `bundleId` must be sent as a **number**, or you get a 422.
  - **The payment and finalise steps have never been observed live**, because no purchase is allowed. They are built from docs and marked unverified in code.

- **`/profile` is ENVELOPED: `{ data: {...} }` (C2-7, 2026-09-27)**. The live response wraps the profile; `modular` read the fields at the top level, so every credit, eligibility and booking-cutoff read was `undefined`. Live, 2 real credits showed as 0 and every row said "Buy Credits". It also silently dropped the member's tier cutoff. `master` never hit this because its client did `res.data || res`, and that step was lost when the provider layer was built. `unwrapProfileEnvelope()` in `codexfit.js` accepts either shape. `/profile` is also single-flighted with a 30 s memo keyed by gym plus session token, never shared across users (C2-6), and invalidated by book, cancel, checkout and profile update.
- **Mocks must mirror the LIVE envelope, not a convenient one.** This bug class has now shipped three times: `/events` relations, `/bundles` (`{data, relations}`, C2-3b) and `/profile` (C2-7). The mock returned a bare shape, every suite was green, and only a live browser check caught it. When you add a mock route, copy the envelope from `server/fixtures/codexfit-v2/*.json`, which are sanitized live captures.
- **Waitlist verbs (C2-2, confirmed live 2026-09-26)**: join is `PUT /waitlists/{eventId}`; **leave is `DELETE /waitlists/{waitlistRowId}`, NOT the event id**. `leaveWaitlist()` resolves the row via `listWaitlists()` first. The doc previously said join was `POST`, which was wrong.
- **Booking response shape**: `POST /bookings` returns `{ success: true, bookings: { "8255409": 53 } }` — the key is the booking ID, value is the slot ID. The client's `tryAutoRegisterUpgrade` extracts the booking ID from this.
- **No booking show/update endpoint**: `GET /bookings/{id}` and `PUT/PATCH /bookings/{id}` all return HTTP 500 `BadMethodCallException` (`BookingController::show`/`::update` does not exist). The routes exist (Laravel `Route::resource` boilerplate) but the methods are unimplemented. `BookingController` only implements `index` (list), `store` (create), `destroy` (cancel). **There is no atomic spot-swap API** — changing spots requires cancel-then-rebook (`DELETE /bookings/{id}` + `POST /bookings`). Confirmed via authenticated API testing; see [psycle_codexfit.md](file:///Users/pierswingfield/Desktop/AI%20Projects/psycle%20chrome/App/Documentation/Services/psycle_codexfit.md) "Spot Swapping Limitations".

- **Sweat Assistant account identity (Decision D4)**: an SA login is no longer a gym login. `users.password_hash` (scrypt, per-user salt, `scrypt$N$r$p$salt$hash`) is the account's own credential, independent of any gym's. A migrated account authenticates **locally** — no gym round-trip — so login survives a gym API outage or a lapsed membership, which is the point. Existing accounts have `password_hash` NULL and fall through to the gym login, which then seeds the hash from the password just proven: a silent migration, no prompt, no reset. A failed SA password does **not** fall back to gym auth (that would let a stale gym password bypass a changed SA password). Unlinking every gym is allowed — the account survives.
- **Account setup**: signup (`POST /api/auth/signup`) creates a Sweat Assistant account with **no gym attached** — gyms are linked afterwards via `POST /api/my-gyms/link`.
- **Gym login identity lives on the link, not the account (WP-D5)**: `user_gyms.gym_email` is the address this account authenticates to *that* gym with. It is a **separate field from `users.email`**, which is the Sweat Assistant identity — conflating them is precisely the coupling D4 exists to break. `linkGymAccount()` stores it (lower-cased) alongside the password, both having just been proven against the gym; `mergeUserWithGym` exposes it as `user.gym_email`. **NULL means "not captured" and must never fall back to `users.email`** — that fallback works for every account today (all default-gym links where the two happen to match) and would silently re-couple the account to the gym, invisibly, until a user with different addresses hits it. Treat NULL as "cannot re-authenticate unattended; the user must re-link". Existing `psycle-london` links were backfilled from `users.email` because there it is provable (pre-D4 an SA login *was* a CodexFit login); links to any other gym were left NULL rather than guessed. Asserted by `server/test-gym-identity.js`.
- **Account recovery: admin-only.** `POST /api/admin/users/:id/reset-password` generates a strong temporary password server-side and returns it **once** for the admin to relay out-of-band (the admin never chooses it; it is not stored in plaintext). Clears stored gym credentials by default — opt out with `{ resetGymCredentials: false }`. There is **no self-service reset**; the mechanism is an open decision (Workstreams C6-1).
- **Never make a gym credential a recovery factor.** A gym-login recovery flow was built and removed on 2026-08-31 (Decision D5): it re-coupled the account to the gym — cancel the membership and you lose the account — and silently promoted the gym password to a master key for the Sweat Assistant account. `POST /api/auth/recover/*` are gone and a regression test asserts they stay gone. Whatever eventually proves identity, a successful recovery must reset **all** stored gym credentials via `db.resetGymCredentials()` (links, queues, spot maps and priority tiers survive; the user re-authenticates each gym).
- **No-gym state**: gym-scoped routes return **409 with `code: 'NO_GYM_LINKED'`**, not 401. A gym-less account is legitimate, and a 401 would send the client round a login loop it cannot win. The client routes that state to a "Connect a gym" screen.
- **Active gym resolution**: `db.resolveActiveGymId(userId)` decides which gym's session, credentials, priority and calendar token every db.js read resolves. Order: per-request gym (from the `x-gym-id` header, **only after `db.isGymLinked()` passes** — an unlinked or unknown gym is a 403, never a silent fallback) → the user's stored `users.active_gym_id` (ignored if they're no longer linked to it) → their sole linked gym → `DEFAULT_GYM_ID`. The request gym travels via `AsyncLocalStorage` (`db.runWithGymContext`), established in `auth.js`'s `authenticateToken`/`authenticateTokenSSE`, so the ~10 internal call sites and all their callers stay untouched. It is scoped to its own user id — an admin request reading another account resolves *that* account's gym, not the admin's. Background cron has no context and uses the persisted path. `resolveActiveGymId` deliberately does **not** check `gyms.enabled`: disabling a gym must not silently move an account already on it onto a different gym's data. The rollout gate lives at selection time (`db.setActiveGym`).
- **No gym is privileged above the adapter layer (WP-D7)**. There are **three** layers, not two: the **platform module** (`providers/codexfit.js`, `providers/marianatek.js`) owns the *protocol* and is shared by every tenant on that platform; a **gym config** entry in `gyms.config.js` owns the *instance and its policy* (URLs, theme, capability flags, and per-gym rules like the booking window); everything above `providers/` knows only normalized types and capability flags. MarianaTek is a platform many gyms use, JAB being one — it is **not** an extension of CodexFit. Practical rules: no module-level `getProvider(...)` const (resolve per request from the active gym, or per row from `row.gym_id`); never `getProvider('some-gym')` with a literal; pass **paths**, not absolute URLs, so the provider prepends its own `apiBaseUrl`; don't name an identifier after one platform. A rule true of Psycle but not of every CodexFit gym belongs in the gym config, not the platform module. `server/test-no-gym-privilege.js` enforces all of this by scanning the source.
- **Booking windows: protocol vs policy (WP-D8)**. Every gym has a booking window; what differs is how it is determined, and **the shapes are genuinely different — not variants of one another**. Three kinds, declared per gym as `bookingWindow.kind`:
  - **`per-class`** — the API publishes a release instant per class. MarianaTek resolves whichever rule the studio uses (interval *or* rolling, per membership tier) **server-side** and publishes `booking_start_datetime`; confirmed against two production captures (marianatek.md §1). **Read it, never compute it.**
  - **`rolling-continuous`** — release = class start minus a fixed span, **exact to the minute**. At 13:30 on 1 Sep with a 14-day window, the 13:30 class on 15 Sep is open and the 14:00 class the same day is not. This is JAB's actual rule, and it is what a `per-class` gym falls back to when a payload omits the field (`bookingWindow.fallback`).
  - **`rolling-weekly`** — a fixed weekday and hour, plus a per-member day offset read from their profile cutoff. Psycle: Monday 12:00, 14-day base, tiers extending it by days. **Different members see different opening dates for the same class**, which is why the offset is resolved per user and never hardcoded.
  A missing release resolves to **null**, never to "now" — `getClassReleaseTime()` returns null and every scheduler call site treats that as "skip", because assuming a class is open fires auto-book weeks early and burns the queue entry. **Psycle's numbers — Monday 12:00, 14-day base, credit type 8 with a 15-day floor — live in `gyms.config.js`, not in `providers/codexfit.js`**: CodexFit is a platform many gyms use, and another could release Sundays at 09:00. The adapter only knows *where* its API exposes the cutoff (`resolveBookingWindow`) and how to compose an instant from a policy (`releaseAtFor`); `providers/booking-window.js` evaluates the policy. `routes-normalized.js` stamps `releaseAt` on every event so **the client reads a timestamp and computes nothing**. The Auto-Book tab therefore shows a **per-class** countdown (`data-release-at` on each card) and a banner counting to the soonest queued release — not one fixed weekly instant, which was only ever right for Psycle and only for one membership tier, and `auto_bookings.release_at` captures it at queue time because a per-class gym has no rule to recompute it from later. `server/test-booking-window-policy.js` pins bit-identical equivalence to the pre-split algorithm over 10,000+ cases. Note `gym.timezone` is also a gym-config field — CodexFit serves timezone-naive datetimes, but which zone they are naive in belongs to the gym.
- **Session renewal is the adapter's job (WP-D7)**: `triggerAutoRelogin(userId, gymId?)` resolves the gym (background callers pass the row's own, since a gym the user isn't looking at still needs renewing) and calls `provider.refreshSession(session, credentials)`. The adapter owns the ladder — refresh token where the platform has one, straight to re-login where it doesn't. **Never branch on the platform at the call site**; that is how "MarianaTek as an extension of CodexFit" creeps back. On failure the session is cleared and the link is flagged `needs_relogin`, but the link itself survives — a transient outage must not cost someone their queue, spot maps and calendar token.
- **The client consumes `Normalized*` types, never `.raw` (WP-D15)**. `NormalizedEvent.raw` exists for the debug panel and nothing else. The timetable used to fetch normalized events then immediately `map(ne => ne.raw)`, which worked only because `.raw` IS a CodexFit event for Psycle — for MarianaTek it is a class with `start_datetime` and the grid threw on first render. Field names to use: `startAt`/`endAt`/`durationMin`, `discipline` (the group), `instructors[0].name`, `studioId`/`studioName`, `locationId`/`locationName`/`locationAddress`, `capacity`/`availableCount`, `isFull`, `waitlistAvailable`, `alwaysBookable`, `layoutFormat`, `releaseAt`.
- **Gym-scoped data: two rules, opposite directions (WP-D6)**. Every per-user table carries `gym_id`, and the DDL default is **gone** — a forgotten `gym_id` is now `NOT NULL constraint failed`, not a silent Psycle row. (1) **Per-user accessors scope to `db.resolveActiveGymId(userId)`.** Several of these tables key on *provider* ids — `studio_id`, `event_id`, `booking_id` — which are unique only within a gym, so an unscoped read hands one gym's spot map to another's booking flow. (2) **Cross-user background scanners must NOT filter by gym** — `getPendingAutoBookings()`, `getActiveAutoUpgrades()`, `getAllBookingCache()`. A user's JAB auto-book has to fire while their *active* gym is Psycle; filtering these silently stops background work for every non-active gym. They select `gym_id` so the caller routes per row, which is why `markAutoBookingExecuted()` takes an explicit `gymId` (from the row) rather than resolving one. Both directions are pinned by `server/test-gym-isolation.js` — the only suite that is multi-gym, so it is the only place a missing `AND gym_id = ?` shows up as red.
- **Gym scoping is not only a database concern (WP-G, revised C3-24/C3-21/C3-23)**. `gym_id` on every table made the DB safe and *hid* the fact that runtime state collided: any **process-local Map/Set or client cache key built from a provider id** is a cross-gym collision, because two gyms can both publish event 12345 slot 7. No SQL predicate can catch it — `test-gym-isolation.js` section 8 exists for exactly this and is the only place it goes red. Gym-qualified: `scheduler.js`'s `claimedSlots`/`burnedSlots` and `poller.js`'s claim key (`gymId:eventId:slot`), the shared `eventCache` (via `eventCacheKey(gymId, eventId)` — `getCachedEvent`/`setCachedEvent` take `gymId` first), and `timetable.js`'s `studioLayoutCache` (`gymId:studioId`). **The client has no gym segment in its cache keys any more**: WP-G's `gymScopedKey()` keyed off `sweatActiveGymId`, which the removed gym switcher wrote and nothing writes now, so it was always empty (C3-24 deleted it). The merged timetable cache is account-scoped on purpose (`accountScopedKey`: `psycleUnifiedCacheEvents/Meta/Time:${userId}`), and anything that describes ONE gym must carry that gym id in its own key at the call site (`/api/credits?gymId=…`, `/api/membership?gymId=…`, `/api/bundles?gymId=…`). **When the linked-gym set changes (link, re-auth, unlink), `syncAfterGymSetChange()` in `settings.js` must run**: it reloads the gym context, drops the unscoped studio-preferences cache and calls `resetTimetableForGymChange()`, which clears the unified cache and refetches — otherwise the merged list keeps the old gym set until a reload (C3-15). `api-responses` is not the only cache (`timetable.js` keeps raw events in its own store), and missing one left a JAB user looking at Psycle's timetable while every network call returned MarianaTek data — caught only by a browser smoke test. Note **auto-book/upgrade quotas are per-gym on purpose** (`MAX_*_PER_GYM` in `server.js`; both counters scope by `resolveActiveGymId`) — the cost they bound is per-gym too. **Gym-scoped routes need a gym named (C3-28)**: on an account with several gyms, `routes-normalized.js resolveContext` answers `400 GYM_REQUIRED` when there is no `x-gym-id`; a single linked gym is unambiguous. Per-gym client state lives in `cache.profilesByGym` / `cache.gymSettings` (read via `profileForGym()` / `gymSetting()`), never in a position in the linked-gym list (C3-17/18).
- **Settings are split by scope (WP-D6)**: `account_settings` holds the keys that belong to the person, `settings` holds one row per gym. `db.getUserSettings()` merges them and `setUserSettings()` fans out, so every caller still sees one flat blob. **Keys default to gym-scoped**; only those in `ACCOUNT_SCOPED_SETTING_KEYS` (notifications, debugMode, autoUpgrade*, prefetchWeeks, theme, calendar) are shared. The default runs that way on purpose — the gym-scoped set is the one that grows with each provider capability, and a missed gym key leaks across gyms invisibly whereas a missed account key merely gets set twice.
- **The calendar feed is ACCOUNT-level (2026-09-14)**. It was gym-scoped, which gave a two-gym member two `.ics` URLs each covering part of their week; a person has one calendar and expects every class in it. The token is now `users.calendar_token` (per-gym `user_gyms.calendar_token` is read only as a migration fallback and is cleared on rotation, so old single-gym URLs stop serving), `getCalendarEnabledUserIds()` reads `account_settings`, and `migrateCalendarSettingsToAccountScope()` folds each gym's copy into one account value — **without it an existing subscriber's feed silently stops updating**, which is exactly the trap the old comment warned about in the other direction. `calendar.js` fans out over `db.getUserGyms()`, one pass per gym inside `db.runWithGymContext`, so the ~20 per-user accessors are unchanged. Three things that bit during the move and will bite again: **the session must be read inside the gym's context** (`db.getUserById` resolves the ACTIVE gym's session, so every non-active gym was handed the wrong token and 401'd while the log still said "across 2 gyms"); **`gatherLiveClasses` keys by `gymId:eventId`**, since provider event ids collide; and **reconciliation is per gym** — an unscoped reconcile sees gym A's classes missing from gym B's live list and deletes them. Per-gym failure degrades that gym only, never blanks the feed. Event `SUMMARY`/`CATEGORIES` name the row's own gym from `gyms.config`, not a hardcoded "Psycle". UI lives in `client/src/ui/calendar-section.js` (Settings → General); there is deliberately no `gymId` in that file.
- **`GET /events` returns events BY REFERENCE**: the list response is `{ data, relations }` — each event carries `event_type_id`/`instructor_id`/`studio_id`, and the sibling `relations` bag holds the entities. It does **not** embed them inline. `codexfit.js`'s `resolveEventRelations()` must be applied to every list event; skipping it produces normalized events with no discipline/studio/location/instructor and makes the UI render a generic "CLASS" pill. `mock.js` mirrors this envelope deliberately — it used to inline the relations, which hid exactly this bug from every test.

## Architecture Constraints

- **Server must handle all background work** (auto-book scheduling, auto-upgrade polling, reminders, calendar feed polling). The PWA is just a UI + push notification receiver.
- **Background work uses the ROW's gym session, never the active gym's (C3-12, 2026-09-26)**. `db.getUserById(userId).jwt` resolves the user's *active* gym. Anything that runs per queue or monitor row (`scheduler.js bookSlotWithRelogin`, `poller.js` fetches, swaps and cancel-then-rebook) must use `db.getUserSession(userId, row.gym_id)`. Otherwise a JAB auto-book for a user whose active gym is Psycle gets sent with Psycle's token. `server/test-background-gym-session.js` pins this.
- **Auto-book precision**: T-50s staggered prefetch → T-5s `setTimeout` → `setInterval` every 10ms polling `Date.now()` until `>= targetRelease`.
- **The QUEUE is the wake clock, not a weekday (WP-I)**. `scheduleReleaseWindow()` arms against `getNextReleaseInstant()` — the soonest **future** release among all pending entries, each resolved by `getClassReleaseTime()` from its own gym's policy or published per-class time. It re-arms after every dispatch and via `scheduler.rearm()` on queue mutation (`server.js` POST/DELETE `/api/auto-book`), because a newly queued class can release sooner than what is armed. **`getNextMondayNoonLondon()` is gone from the server** — it was Psycle policy sitting in the orchestrator, and it made a per-class gym's auto-book fail *twice over*: the process never woke at the right instant, and the release-group filter then rejected the class for not matching the wrong instant (measured 50.2h off — the entry simply never fired). Psycle is unchanged in effect: its entries still resolve to Monday 12:00 London and its priority cohort still dispatches together, since the `|release - target| < 10s` group predicate is untouched. Corollaries: an **empty queue arms nothing** and clears `scheduler_next_release`, so `/api/health` reports `nextReleaseAt: null` when idle (correct, not a fault) and the value is **no longer always a Monday**; an entry with an unresolvable release is **dropped, never treated as "now"** — `getClassReleaseTime()` returns `null` for a row with neither `release_at` nor `start_at`, where it previously returned `DateTime.now()`; that was survivable only because the old Monday-noon filter rejected a "releases now" row, and the queue-driven clock made it dispatch instantly instead; and missed-release recovery reads the queue instead of guessing `Monday - 1 week`. Pinned by `server/test-wake-clock.js`, which asserts the *chosen wake instant* — the assertion whose absence let the hardcoded Monday survive WP-D8. **Note `client/src/lib.js` still has its own `getNextMondayNoonLondon()`** (used by `timetable.js`); that is now the last copy of the constant.
- **Priority tiers + fair dispatch**: `users.priority` (lower = higher precedence; default 100, new users get 200) drives dispatch ordering within a release group. `getPendingAutoBookings()` JOINs `users.priority` and sorts `ORDER BY priority ASC, created_at ASC`; Fisher-Yates shuffle within each tier gives statistical fairness over weeks. `CLAIM_STAGGER_MS = 80ms` staggers consecutive users in the same class. Cross-user `claimedSlots`/`burnedSlots` Sets prevent duplicate `POST /bookings` across concurrent users targeting the same event/slot. Admin-editable via `PUT /api/admin/users/:id/priority`.
- **Auto-upgrade**: Configurable polling (1min/15min/1hr) via `node-cron` every minute. Stops at 12h before class start (or one final "keep original" attempt if `keepOriginalOnCutoff`). Hard stop at 1h.
- **Provider throttling (C2-3, 2026-09-26)**: `classifyProviderThrottle()` (`providers/base.js`) treats any 429 as throttling, but a 403 only when it has corroborating evidence (a `Retry-After` header or throttle wording). A plain permission 403 is left alone. The per-gym backoff and its once-a-day `providerThrottled` notification live in **one shared module, `server/rate-limit-backoff.js`**, used by both `scheduler.js` and `poller.js`. Never keep a second copy of the backoff state. `calendar.js` does not consult it yet.
- **Background relogin suspension (C6-4, 2026-09-28)**: `user_gyms` counts consecutive background relogin failures. After **3 credential rejections**, retries for that link are suspended; they fail fast without contacting the gym, so a changed gym password can't get the account locked. A provider outage counts toward the total but never suspends. A successful renewal, a re-link or an admin credential reset clears the count. Admins see a pill per gym in `/admin`.
- **Competing auto-books (C5-3, 2026-09-28)**: `server/competing-bookings.js` is pure. An exact duplicate that is still pending (same gym and event) gets **409 `DUPLICATE_AUTO_BOOK`**. Time overlaps, including across gyms, and "already booked" come back as `warnings[]` on a 200, not errors, because a member may queue alternatives on purpose. Overlap uses each row's own gym timezone and `auto_bookings.duration_min`, defaulting to 45.
- **Paused auto-upgrades resume (C5-1)**: `poller.resumePausedUpgrades()` re-checks `paused_no_credits` monitors each cycle, at most every 15 min per monitor, with one credits read per user and gym. It uses the same usable-credit rule as the pause, so a monitor can't flap. A monitor past its cutoff becomes `stopped` instead of resuming.
- **Rate limiting**: Five `express-rate-limit` limiters (production-only, skipped in dev): `extrasLimiter` in `routes-normalized.js` (60/min per user on the capability-gated extras that replaced `/api/proxy/*`), plus `readLimiter` (**300/min per user**, one shared counter across the normalized GET routes) and `refreshLimiter` (**30/min per user** on `?refresh=1`, which bypasses the shared cache). These two were added as C7-1 on 2026-09-27; a heavy real session measured 61 calls. `RATE_LIMIT_TEST_FORCE` turns them on in tests, `bookingMutationLimiter` (10/min per user on auto-book/upgrade writes), `calendarFeedLimiter` (60/min per IP on the public calendar URL), `authLoginLimiter` (10/15min per IP on `/api/auth/login`), `adminLoginLimiter` (5/15min per IP on `/api/admin/login`). Per-user quotas cap auto-book at 15 pending entries and auto-upgrade at 10 active monitors (429 on exceed).
- **CORS**: Browser-origin allowlist (`config.corsOrigins`, override via `CORS_ORIGINS`). The PWA is served same-origin in production, so only the public host is allowed; localhost dev origins are added when `NODE_ENV !== 'production'`. Requests with no `Origin` header (curl, native calendar clients, same-origin nav) pass through; disallowed origins get no CORS headers (browser blocks them) rather than a 500.
- **Admin auth**: `/api/admin/login` compares the password in constant time (`crypto.timingSafeEqual` over SHA-256 digests) to avoid timing leaks, and is brute-force-limited (5/15min per IP).
- **Credential storage**: AES-256-GCM encryption at rest. Master key MUST come from the `ENCRYPTION_KEY` env var — the server refuses to start if it is absent (no DB fallback). Never in DB as plaintext.
- **Calendar feed**: Per-**account** rotatable token (`users.calendar_token`) authenticates the public `.ics` URL, and one feed carries every linked gym. A 3-hourly cron polls CodexFit bookings/waitlists and regenerates each enabled user's snapshot; booking mutations trigger a debounced (60s) refresh. RFC 5545 serialization with `Europe/London` VTIMEZONE and optional VALARM.
- **Admin panel**: Standalone SPA at `/admin`, gated by `ADMIN_PASSWORD` env var (503 if absent) + 1h admin JWT. Read-only user list/detail plus inline priority-tier editing and user deletion.
- **PWA must work on iOS 16.4+** via "Add to Home Screen". No background sync on iOS — server handles everything. Push notifications require the PWA to be installed to home screen. First-run onboarding guides install + login + notifications + calendar + spot maps.
- **Timezone**: All cutoff/release calculations must use `Europe/London` timezone. The server uses Luxon; the client uses Luxon via `src/lib.js`. Never use bare `new Date()` for booking window math.
- **Shared spot map**: One preference map per studio (`studio_preferences[studioId] = { preferredSlots[], preferredRows[] }`) is the single source of truth for Quick-Book, Auto-Book, and Auto-Upgrade. All three read it live from the server. The floor-plan editor in `spotmap.js` is reused everywhere the map is edited.

## Shared Spot Map Architecture

There is **one shared preferred spot map per studio**:
- **Storage**: `studio_preferences` SQLite table, keyed by `(user_id, studio_id)`, value is JSON `{ preferredSlots: number[], preferredRows: number[] }`.
- `preferredSlots` — ordered list of slot IDs (order = priority; badge shows 1, 2, 3…).
- `preferredRows` — list of row Y-coordinates (rounded to 0.1) representing whole-row preferences.
- **Editor**: `client/src/ui/spotmap.js` exports `renderStudioFloorPlan(container, layoutSlots, initialSlots, initialRows, onSave, options)` — reused by Settings, Auto-Book, Quick-Book, and Auto-Upgrade configuration modals.
- **Live resolution**: The server's `scheduler.js` `resolveLiveMap()` reads the shared map at execution time. Auto-upgrade's `poller.js` reads it at each check.

## Notification System

Five notification types, all server-side, all deduped via the `sent_notifications` SQLite table:

| Type | Triggered by | Condition | Default |
|------|-------------|-----------|---------|
| `booking` | `scheduler.executeAutoBookForClass` (auto-book success) or client `notifyBookingSuccess` (manual/quick-book) | `prefs.booking.enabled`; if `scope='autobook'` then only auto-book source | enabled, scope: all |
| `upgrade` | `poller.attemptUpgradeSlot` (upgrade success) | `prefs.upgrade.enabled` | enabled |
| `creditWarning` | `server.js` POST `/api/auto-book` or `/api/auto-upgrade` | `prefs.creditWarning.enabled` | enabled |
| `cancellationReminder` | `poller.checkCancellationReminders` (local timer, reads `booking_cache`) | `prefs.cancellationReminder.enabled`; fires at 24h or 14h before class, only inside free-cancel window | enabled, timing: 24h |
| `bookingWindow` | `poller.checkBookingWindowReminder` (weekly at Mon 11AM) | `prefs.bookingWindow.enabled`; contextual tip based on queue count + credits | enabled |

- **Dispatch**: `notifications.js` `notify(userId, type, ctx)` builds the body, checks user prefs, calls `push.js` `sendNotification()` which fans out to all `push_subscriptions` for the user. Expired subscriptions (410/404) are auto-deleted.
- **Dedupe**: `sent_notifications` table with `UNIQUE(user_id, dedupe_key)`.
- **Client prefs UI**: Settings → "Customise Notifications" modal (`settings.js` `renderNotifPrefs`).

## Health Check & Uptime Monitoring

The background services (auto-book scheduler, auto-upgrade poller, calendar feed) run as in-process timers/cron. `GET /api/health` reads heartbeats written by each service to `server_kv` and returns 200 OK (if healthy) or 503 degraded (if heartbeats are stale).

---

## Feature Implementation Status

| Feature | Status | Notes |
|---------|--------|-------|
| **Login/Auth** | ✅ Functional | Server BFF + JWT, direct login + auto-relogin on 401 |
| **Timetable** | ✅ Functional | Filters, date carousel, status badges, IndexedDB 4hr TTL cache |
| **Studio Floor Plan** | ✅ Functional | Occupancy tooltip + booking modal with spot selection |
| **Instructor Tooltip** | ✅ Functional | Hover tooltip (1s delay) + touch tap-to-toggle; Instagram/Spotify links |
| **Quick Book** | ✅ Functional | One-click if prefs exist, else opens floor-plan modal |
| **Auto-Book** | ✅ Functional | Server-side precision scheduler + priority tiers + SSE live status stream |
| **Auto-Upgrade** | ✅ Functional | Server-side cron + 12h/1h cutoff + auto-register after booking |
| **My Bookings** | ✅ Functional | Penalty warning, double-click confirm, auto-upgrade toggle per row |
| **Waitlists** | ✅ Functional | Join from timetable, leave from bookings, double-click confirm |
| **Bookmarks** | ✅ Functional | Native CodexFit bookmarks, "favourites only" filter |
| **Buy Credits** | ✅ Functional | Bundle cards, 8 filters, two-click cart → in-app Stripe checkout (website fallback for 3DS) |
| **Settings** | ✅ Functional | General / Notifications / Account / Your Gyms / About, plus **one sidebar entry per linked gym**. Your Gyms is a connection table (health + last authenticated). No drawer, no gym switcher. |
| **Debug Mode** | ✅ Functional | Per-class debug modal, debug log terminal, simulate release |
| **Push Notifications** | ✅ Functional | VAPID, 5 types, per-user prefs, auto-generated keys, click deep-linking, open-app auto-refresh |
| **Config Export/Import**| ✅ Functional | JSON configuration backup and restore |
| **Smart Caching** | ✅ Functional | Account-scoped unified timetable cache paints first, then metadata/action/timetable data refresh in the background; normalized API responses remain user+gym scoped |
| **Prefetch Weeks Setting**| ✅ Functional | 1-8 weeks dropdown in Settings |
| **Multi-slot Booking** | ✅ Functional | Qty selector in quick-book + auto-book modal; multi-spot selection in simple book mode |
| **Spot Map Editor** | ✅ Functional | Shared map editor in Settings, reused by all booking flows |
| **Profile Explorer** | ✅ Functional | Categorized CodexFit profile viewer + Konami-code edit mode |
| **Notification Prefs** | ✅ Functional | Per-type toggles + scope/timing dropdowns |
| **Cancellation Reminders**| ✅ Functional | 24h/14h before class, deduped, reads booking cache |
| **Booking Window Reminder**| ✅ Functional | 1hr before Monday release, contextual tip |
| **SSE Live Status** | ✅ Functional | Real-time auto-book execution updates via Server-Sent Events |
| **Booking Cache Sync** | ✅ Functional | Client pushes bookings to server for reminder cache |
| **Calendar Feed** | ✅ Functional | Per-**account** .ics feed spanning every linked gym (webcal/Google), token auth, 3-hourly poll, VALARM, Europe/London VTIMEZONE |
| **First-run Onboarding** | ✅ Functional | 6-step guided flow (intro → install → login → notifs → calendar → spot maps) |
| **Offline Support** | ✅ Functional | SW network-first shell + cache-first assets, offline banner, button disabling |
| **Pull-to-refresh** | ✅ Functional | Reusable pull-to-refresh on scroll containers (timetable, bookings, auto-book) |
| **Theme Toggle** | ✅ Functional | Auto/Light/Dark segmented control, persisted to localStorage |
| **Admin Panel** | ✅ Functional | Standalone SPA at /admin, user list/detail, priority-tier editing, delete |
| **Rate Limiting & Quotas**| ✅ Functional | 3 per-user limiters + auto-book (15) / auto-upgrade (10) quotas |
| **Auto-Book Favourites** | ⚠️ Incomplete | UI saves favourite list to settings, but server doesn't auto-populate queue from it |
| **.ics File Download** | ❌ Not Planned | A live calendar *feed* is provided instead of a one-off file download |

## Known Bugs, Open Work and Invariants

- **Per-class credit cost and accepted types come from the PROVIDER, never from arithmetic on a balance (2026-09-15).** Psycle's public `GET /events` publishes `required_credits`, `credit_types`/`accepted_credits` and a `relations.credit_types` bag on every event — measured on 2,482 live events: 2,472 cost 1, **5 cost 2, 2 cost 3**, 3 cost 0, and **11 of 46 credit types are `is_guest_use_only`** (classes accept them, for booking a *guest* in). None of this was normalized, so `NormalizedEvent` had no `credit_types` at all, the client's per-class matching was dead code returning `Infinity`, and the only real check was the server's `sum(all credits) > 0` — wrong in both directions (bookable when you can't afford a 2-credit class; blocked when you hold the wrong type). Now `NormalizedEvent.credits = { required, acceptedTypeIds }` and `NormalizedCredit.isGuestOnly`; `getAvailableCreditsForEvent` returns **bookable spots** (`floor(usable / required)`), not a credit count. **An absent `credits` field means "the payload said nothing", not "free"** — treating it as free is what let the normalization gap go unnoticed, so it falls back to cost 1 / any type. `mock.js` models all of these fields; without that a regression here goes undetected.
- **The schedule cache is SHARED and user-agnostic (`server/schedule-cache.js`, 2026-09-15).** The timetable was slow on the *second* load too, because nothing cached it server-side: live Psycle is **6,105ms cold for 2,482 events, 0ms warm**, and a merged two-gym view paid a cold fetch per gym per user per visit. Stale-while-revalidate with single-flight (N concurrent cold readers → one provider call, which is what a release instant looks like). **The key is `gymId + date range and deliberately carries no user id.** `releaseAt` depends on the member's own booking-window tier and is stamped per request *after* the cache — caching the stamped result serves one member's release times to another, a correctness bug rather than a staleness trade. Write paths invalidate their own gym; `?refresh=1` bypasses, set only by the explicit refresh control. A failed background refresh keeps the last good value rather than emptying the page for everyone. Counters on `/api/health`.
- **Keep three separate questions separate: `metered`, `creditPurchase`, and eligibility.** Eligibility is now implemented through `provider.getEligibility()` → `GET /api/eligibility` → `cache.eligibility`; MarianaTek derives it from an active membership or usable credits. Credit arithmetic remains exclusively in `client/src/ui/credit-allowance.js` and returns `Infinity` when unmetered. Do not re-derive membership eligibility from a credit total, and keep `available_credits.reduce` inside that module only.
- **A one-platform feature gets a NAMED route, never a passthrough.** Bookmarks, `/bundles` and the Konami profile edit are CodexFit-only, and keeping them on a raw passthrough is what kept `/api/proxy` alive for three attempts to delete it. They are now `GET /api/bundles`, `PUT|DELETE /api/bookmarks/:identifier` and `POST /api/profile/update`, each gated on the **gym's** capability flag before the adapter is reached. `test-regression-psycle.js` asserts `/api/proxy/*` returns 404. Normalize `/bundles` properly when a second provider can sell packs.
- **A capability or balance question in a LIST must be asked per row, with that row's gym (`canForGym`, 2026-09-15).** `can('metered')` answers for whichever gym the app defaults to, so in a merged timetable a JAB class was evaluated against Psycle's `metered: true` AND Psycle's credit balance — with no Psycle credits, *every* row (JAB membership classes included) showed "Buy Credits". Same for eligibility: `cache.eligibilityByGym` is keyed per gym, and with several gyms linked a missing entry falls back to **nothing**, not to the account-level value, because that value belongs to one gym.
- **"Not loaded" is not "zero" (2026-09-15).** The per-gym credit/eligibility fan-out is fire-and-forget, so the first paint runs before it lands. Returning `[]`/`0` there reads as "you have no credits" and put "Buy Credits" on every row until the user switched days and forced a re-render. `creditsFor()` returns **null** when unknown and the arithmetic answers permissively — the same unknown-defaults-ON rule as capability flags — and `repaintTimetableIfVisible()` re-renders when the real answer arrives. Do not "simplify" the null away.
- **`layoutFormat` is per CLASS, not per studio (2026-09-15).** JAB's BOXING room runs both `first-come-first-serve` and `pick-a-spot` classes, so any studio-level inference is wrong for half of them. `getStudioMapInfo()` reads the EVENT's `layoutFormat` first: FCFS means there is definitively no seat map, which is what makes those rows one-tap "Quick Book" instead of opening an empty picker. This matters because `resolveHasMap()` answers TRUE for an *unknown* studio (unknown-defaults-ON) and MarianaTek derives its studio list from its class list — so an FCFS class can have no studio entry at all and fall straight through the guard. The mocks hid it because their studios always exist.
- **One lookup per fact.** Quick-Book and the auto-upgrade registration each had their own preferred-spot-map lookup and they disagreed: a booking would quick-book into a preferred spot and then immediately toast "you don't have a preferred spot map for this studio". There is now one `resolveStudioPrefs(event)` in `timetable.js`. Two lookups for one fact will always drift.
- **Same principle, instructor avatars (2026-09-15).** `instructorAvatar()` used to ALWAYS re-look-up a photo by name against `metadata.instructors`, even when the caller already had the photo sitting on its own data — MarianaTek's event/booking objects carry `instructors[].thumbUrl`/`imageUrl` directly. The name lookup is lossy for a MarianaTek gym specifically, because that gym's `metadata.instructors` is derived from whatever's currently in the public class-list window (`marianatek.js fetchMetadata`) and doesn't reliably include every class a member has already booked — so the same instructor's photo would resolve on one page load and silently miss on the next, independent of image loading. `instructorAvatar(name, gymId, directUrl)` now takes the direct photo when the caller has one; the name lookup is the fallback for CodexFit (whose per-event instructor objects never carry a photo at all) and for Auto-Book/Auto-Upgrade rows (DB rows store only `instructor_name`).
- **A gym-derived taxonomy field needs a live check, not one example.** JAB's `discipline` read `classroom_name` (the physical room) because in the one captured example the room ("TRAIN") happened to equal the class's own discipline prefix. Confirmed wrong against 855 live classes (68 disagreed) — e.g. "Small Group Boxing PT" sits in a room called "Boxing Studio", which then showed as the class's discipline everywhere: the filter dropdown and the row's pill. `class_type.name` is the only real category MarianaTek's Customer API exposes (there is no `class_session_type` field on the live payload, despite that name appearing in the platform's own docs as a filter param) — `discipline` now reads that instead, falling back to `classroom_name` only if a class ever has no `class_type` at all.
- **Every toast variant needs a CSS rule.** `.psycle-toast.warning` had none, so a warning rendered as near-white text on no background — it looked like a rendering fault, not a message. There is now a `:not(...)` catch-all giving an unknown variant a readable surface; keep it.

- **Capability-gating markup means gating its event wiring too** — the bookmark heart's HTML was gated on `capabilities.bookmarks` but `row.querySelector('.psycle-timetable-heart').onclick` was not, so it threw on every row and emptied the **entire** timetable for a gym without bookmarks. Gate both, or neither.
- **Table column widths: four things that do NOT work, and the one that does (2026-09-15).** The occupancy pill overlapping the action buttons took five attempts because every fix *looked* right. In `table-layout: auto`: (1) **`min-width` on a `<td>` is ignored** — columns are sized from content, and three separate floors on `td.col-actions` did nothing (the cell measured 1px while Status took 388px); (2) **`width: 1px` shrink-to-fit lets content OVERFLOW** rather than expanding the cell, which is how a 162px button group ended up spilling left across Status; (3) **`min-width` on the cell's child does not propagate** to the column; (4) **percentage hints are only hints** and the browser resolves an over-constrained table by squeezing whichever column it likes. What works is an **explicit px width** (Status is `112px` for this reason) plus `min-width: max-content` on the *content* of the shrink-to-fit column. And **`.psycle-table` carries `max-width: 100%`** so the table can never widen past its container — without it the action buttons painted outside the card's rounded edge.
- **Measure the thing the user sees.** That overlap was reported fixed twice while still broken, because the check compared **cell edges** — and the pill overflows its cell. The honest metric is pill-right vs button-left; on it, 19 rows were overlapping.
- **In this stylesheet, `!important` beats specificity and source order beats ties.** Two rules were written correctly and did nothing: a `display: none` without `!important` lost to the generic `.psycle-table td { display: table-cell !important }`, so the merged instructor+location column rendered at desktop width *alongside* the columns it replaces; and the Settings submenu indent (line ~5222) lost on source order to the base menu-item rule (~8356) at equal specificity. Any new rule targeting a table cell or a settings menu item needs `!important` and needs to sit after the base rule. This is a symptom of the 637-`!important` problem — tracked as Workstreams U3-2.
- **`[hidden]` loses to an inline `display`** — several elements in `index.html` carry one, so gated features stayed fully visible. `styles.css` has `[hidden] { display: none !important; }`; don't remove it.
- **A `border-radius` container needs an explicit `overflow` too.** `.psycle-table-container` had the radius but no `overflow` set, so a row's hard-cornered background (hover tint, per-gym tint) painted flush past the rounded corner on the first/last row. `overflow: hidden` fixed it — the table doesn't scroll independently (the panel body does), so this never fights a scrollbar.
- **An unknown capability flag must default to ON** — hiding a feature a gym *has* is permanent and silent; briefly showing one it hasn't self-corrects when the catalogue loads. See `client/src/gym-context.js`.
- **Normalized ids are STRINGS, raw event fields are numbers** — `metadata.studios.find(s => s.id === e.studio_id)` is silently false, not an error. Use `sameId()`/`String()`. This shipped twice during WP-D9: once caught by tests, once only by a browser smoke test (the location filter rendered an empty dropdown).
- **`detectBookingWindow()` duplicated in the client** — `client/src/lib.js` still reimplements what `providers/codexfit.js resolveBookingWindow()` does server-side. Off the correctness path (the server stamps `releaseAt`), but it is Psycle policy in shared client code and should move.
- **Auto-Book Favourites incomplete** — The Auto-Book tab has a "♥ Auto-Book Favourites" modal that saves `autoBookFavourites` (a list of bookmark identifiers) to user settings, but nothing in `scheduler.js` consumes this list to auto-create queue entries each week. The auto-sync logic for autoBookFavourites has not yet been built.
- **Service-worker cache names are build-stamped (C7-2)**. `client/public/sw.js` uses `sweat-cache-__BUILD_STAMP__`, which the `stampServiceWorker()` Vite plugin rewrites at build time, so a deploy can no longer ship stale JS behind an unchanged cache name. `activate` purges both older stamps and the legacy `psycle-cache-*` names.
- **Mobile/iOS layout uses fixed dimension layout** — The root panel base is still `width: 1080px; max-height: 85vh; border-radius: 28px` (desktop design heritage). Responsive media queries (`@media max-width: 1100px/480px`) now make it full-width on small screens and an iOS bottom nav was added, but the base dimensions mean it doesn't feel fully native on iOS installed to home screen. A dedicated mobile-first layout pass would improve this.
- **Inline styles everywhere** — UI modules build elements with large `style="..."` strings instead of CSS classes, making maintenance and responsive tweaks painful (can't media-query inline styles). `cards.js` extracts some shared helpers, but most modules still inline. Should be migrated to `styles.css` classes over time. (`styles.css` is the only stylesheet imported in `index.html`.)
- **3-D Secure not handled in-app** — In-app credit checkout charges a saved card off-session. When the charge requires 3-D Secure authentication, the server returns `status: 'requires_action'` and the client falls back to the website checkout with tips. The full Stripe.js `confirmCardPayment` challenge flow is not yet built (tracked as Workstreams F-1; spec: [3d_secure_checkout.md](file:///Users/pierswingfield/Desktop/AI%20Projects/psycle%20chrome/App/Documentation/Archive/2026-09-26/Backlog/3d_secure_checkout.md)).
- **Unescaped innerHTML from CodexFit data** — UI modules widely interpolate class names, instructor names, studio names, etc. into `innerHTML` without escaping. An `escapeHtml` helper exists and is used in the debug modal, but most rendering is unprotected. CodexFit is a semi-trusted source (you authenticate with your own credentials), so XSS risk is low in practice, but a malicious or garbled class/instructor/location name in the API response could inject HTML/script. A scoped audit-and-escape refactor is needed, but only if working on the UI-rendering pipeline more broadly.

---

## Server API Routes

```
# Public Config + Health (no auth)
GET    /api/config                # Returns { appName, publicHost } — needed before login to render UI
GET    /api/health                # Liveness probe — 200 when heartbeats are fresh, 503 if degraded

# Admin Panel
GET    /admin                     # Serves admin.html (standalone admin SPA)
POST   /api/admin/login           # Verify ADMIN_PASSWORD, issue 1h admin JWT
GET    /api/admin/users           # List all users with queue counts + priority
GET    /api/admin/users/:id       # Full user detail (profile, credits, bookings, queue, monitors, spot maps)
PUT    /api/admin/users/:id/priority  # Update a user's priority tier (1–999)
POST   /api/admin/users/:id/reset-password  # Generate a temp password (shown once); clears gym creds by default
POST   /api/admin/users/:id/link-gym  # Link a gym to a user (no credential verification — DB link only)
DELETE /api/admin/users/:id       # Delete user + all CASCADE data

# Auth
POST   /api/auth/login              # Login → CodexFit BFF, returns local JWT
GET    /api/auth/status             # Check local JWT validity
DELETE /api/auth/me                 # Delete all user data (account, creds, queue, prefs, push)

# Normalized gym-agnostic API (WP-N1/D9) — WHAT NEW CODE SHOULD USE
# Every route below returns Normalized* shapes (see providers/base.js) and works
# for any gym. Backed by routes-normalized.js → a provider adapter.
GET    /api/timetable               # NormalizedEvent[] (releaseAt stamped per event)
GET    /api/metadata                # { locations, studios, instructors, classTypes }
GET    /api/events/:id              # { event, slots, objects, maxBookableSlots }
GET    /api/studios/:id/layout      # { slots, objects } — empty slots = no floor map
GET    /api/bookings                # NormalizedBooking[]
GET    /api/waitlists               # NormalizedBooking[]
GET    /api/profile                 # NormalizedProfile
GET    /api/credits                 # Credit inventory (empty for membership-based gyms)
GET    /api/cancel-penalty/:id      # Whether cancelling incurs a penalty
POST   /api/book                    # NormalizedBookingResult
POST   /api/cancel
POST   /api/swap                    # Atomic spot swap (gyms with capabilities.atomicSwap)
POST   /api/waitlist/join
POST   /api/waitlist/leave

# Capability-gated provider extras (WP-D9). The raw /api/proxy passthrough is
# GONE — no client code can name a provider's own URL. A feature only one
# platform has gets a NAMED route gated on the gym's capability flag (501
# CAPABILITY_UNSUPPORTED otherwise), never a passthrough.
# (REMOVED 2026-09-14 — its last callers became the capability-gated routes below.)
GET    /api/bundles                 # Credit packs (gyms with capabilities.creditPurchase)
PUT    /api/bookmarks/:identifier   # Save a class (gyms with capabilities.bookmarks)
DELETE /api/bookmarks/:identifier
POST   /api/profile/update          # Profile Explorer's hidden edit mode

# Gyms (multi-gym)
GET    /api/gyms                    # Public catalogue of configured gyms + capability flags
GET    /api/my-gyms                 # Gyms THIS account is linked to + activeGymId
POST   /api/my-gyms/active          # Persist the user's gym choice (403 if unlinked/disabled/unknown)
POST   /api/my-gyms/link            # Link a gym, or re-authenticate a stale credential (same op)
DELETE /api/my-gyms/:gymId          # Unlink a gym; the SA account survives (D4)
POST   /api/account/password        # Change the Sweat Assistant password (independent of any gym)

# Account setup (no auth)
POST   /api/auth/signup             # Create an SA account (no gym attached) — returns { token, needsGym }
# NOTE: no recovery endpoints — the gym-login mechanism was removed (see above)

# Auto-Book
GET    /api/auto-book               # List user's auto-book queue
POST   /api/auto-book               # Add to auto-book queue
PUT    /api/auto-book/:id           # Update auto-book preferences
DELETE /api/auto-book/:id           # Remove from auto-book queue
POST   /api/simulate-release        # Debug: force-execute all pending bookings now
GET    /api/auto-book/stream        # SSE: real-time auto-book execution status

# Auto-Upgrade
GET    /api/auto-upgrade            # List user's auto-upgrade monitors
POST   /api/auto-upgrade            # Set up auto-upgrade
PUT    /api/auto-upgrade/:id        # Update auto-upgrade
DELETE /api/auto-upgrade/:id        # Cancel auto-upgrade

# Settings & Preferences
GET    /api/settings                # Get user settings
PUT    /api/settings                # Update user settings
GET    /api/studio-preferences      # Get all studio preference maps
PUT    /api/studio-preferences/:id  # Update studio preference map

# Calendar Feed
GET    /api/calendar/:token.ics     # Public-by-token iCalendar feed
GET    /api/calendar/status         # Feed status, links, last-generated timestamp
POST   /api/calendar/enable         # Enable feed, generate/rotate token, rebuild snapshot
POST   /api/calendar/disable        # Disable feed, revoke token
POST   /api/calendar/rotate         # Rotate token + republish snapshot
POST   /api/calendar/refresh        # Debounced async refresh

# Backup & Migration
GET    /api/config/export           # Export all preferences as JSON
POST   /api/config/import           # Import preferences from JSON

# Cart (Legacy BFF Endpoints - Upstream migrating to CodexFit v2)
POST   /api/cart/add-bundle/:id     # Add bundle to cart (legacy v1 fallback)
POST   /api/cart/checkout/init/:bundleId  # In-app checkout step 1: add bundle + list saved cards
POST   /api/cart/checkout/confirm         # In-app checkout step 2: place order, poll Stripe, return status
# Upstream CodexFit v2 API: POST /api/customer/v2/cart/{uuid}/lines, POST .../finalise

# Push Notifications
GET    /api/push/vapid-public-key   # Get VAPID public key
POST   /api/push/subscribe          # Register push subscription
POST   /api/push/unsubscribe        # Unregister push subscription by endpoint
POST   /api/push/test               # Send generic test push
POST   /api/push/test/:type         # Send typed sample notification (debug)

# Notifications & Sync
POST   /api/notify/booking-success  # Client reports manual/quick booking → server fans out push
POST   /api/bookings/sync           # Client pushes bookings to warm server reminder cache
```

## SQLite Schema (15 tables)

| Table | Purpose | Key columns |
|-------|---------|-------------|
| `users` | SA account identity | `email` (**the SA login, never a gym's**), `password_hash` (scrypt, the SA credential — D4), `active_gym_id` (last-selected gym), plus vestigial dual-written `encrypted_password`/`jwt`/`priority`/`display_name`/`profile_json`/`calendar_token` columns that `user_gyms` superseded in WP-D3 |
| `gyms` | Registry mirror of `gyms.config.js` | `id`, `name`, `provider`, `enabled`. Synced from the config on every boot — the **config file is authoritative**, this exists for referential integrity + admin display |
| `user_gyms` | One row per (account, gym) link — the real source of truth for auth/session/priority/calendar since WP-D3 | `gym_email` (**that gym's login, distinct from `users.email` — D5**), `encrypted_password`, `session_json` (AuthSession incl. refresh token), `calendar_token`, `priority`, `status`, `UNIQUE(user_id, gym_id)` |
| `auto_bookings` | Auto-book queue + history | `event_id`, `preferences` (JSON), `status`, `executed_at`, `studio_id`, `group_name` |
| `auto_upgrades` | Auto-upgrade monitors | `event_id`, `booking_id`, `current_slot_id`, `preferences` (JSON), `status`, `upgraded_slot_id`, `studio_id`, `original_slot_id` |
| `studio_preferences` | Shared spot maps | `studio_id`, `preferences` (JSON: `{preferredSlots[], preferredRows[]}`), `UNIQUE(user_id, studio_id)` |
| `settings` | Per-**gym** settings | `gym_id`, `preferences` (JSON blob — the gym-scoped keys: detectedBookingOffset, cartInstanceId, calendar, autoBookFavourites…), `UNIQUE(user_id, gym_id)` |
| `account_settings` | Per-**account** settings (WP-D6) | `preferences` (JSON blob — `ACCOUNT_SCOPED_SETTING_KEYS` only: notifications, debugMode, autoUpgrade*, prefetchWeeks, theme). Merged with the gym row by `getUserSettings()` |
| `push_subscriptions` | Web Push endpoints | `subscription` (JSON string) |
| `booking_cache` | Reminder cache (client-synced) | `booking_id`, `event_id`, `start_at`, `slot_label`, `duration_min`, `location_address`, `UNIQUE(user_id, booking_id)` |
| `waitlist_cache` | Waitlist reminder cache (client-synced) | `event_id`, `start_at`, `studio_id`, `location_address`, `UNIQUE(user_id, event_id)` |
| `sent_notifications` | Notification dedupe | `dedupe_key`, `UNIQUE(user_id, dedupe_key)` |
| `calendar_classes` | Per-user calendar event rows | `event_id`, `start_at`, `class_name`, `slot_label`, `status`, `upgrade_note`, `sequence`, `content_hash`, `UNIQUE(user_id, event_id)` |
| `calendar_snapshots` | Generated .ics per user | `ics`, `etag`, `class_count`, `generated_at` (PK `user_id`) |
| `server_kv` | Key-value store | `jwt_secret`, `vapid_public_key`, `vapid_private_key`, `locations_json`, `studio_name_map` |

## Client-Side Storage Schema (PWA)

| Key | Location | Purpose |
|-----|----------|---------|
| `psycleLocalToken` | `localStorage` | Local JWT (30-day, issued by server BFF) |
| `psycleUserId` | `localStorage` | Per-user cache key prefix, set after login |
| `psycleTheme` | `localStorage` | Theme preference: `auto` \| `light` \| `dark` |
| `psycleDefaultFilters` | `localStorage` | Saved timetable filter selections (locations, instructors, eventTypes, bookmarks) |
| `psycleCacheEvents` / `psycleCacheMeta` | IndexedDB | Cached timetable events + metadata |
| `psycleCacheTime` | `localStorage` | Cache timestamp for TTL check |
| `psycleActiveStudioIds` / `psycleActiveStudioIdsTime` | `localStorage` | Active studio IDs for Spot Maps manager (24h TTL) |
| `psycleOnboardingComplete` | `localStorage` | Onboarding completion flag (value = version string) |
| `psycleOnboardingStep` | `localStorage` | Current onboarding step (resumable on iOS after install relaunch) |

IndexedDB database `psycle-cache` (v2) has two stores: `cache` (raw timetable events + metadata) and `api-responses` (all API GET response caching, per-user key prefix isolation).

## Environment Variables

| Variable | Used by | Purpose |
|----------|---------|---------|
| `PORT` | `server.js` | HTTP server port (default 3000) |
| `NODE_ENV` | `server.js` | If `production`, serves SPA static files |
| `DB_PATH` | `db.js` | SQLite database file path |
| `JWT_SECRET` | `auth.js`, `admin.js` | Secret for signing local PWA JWTs and admin JWTs (auto-generated + DB-stored fallback) |
| `ENCRYPTION_KEY` | `crypto.js` | **Required.** Master key for AES-256-GCM password encryption. Server refuses to start if absent (no DB fallback). |
| `VAPID_PUBLIC_KEY` | `push.js` | VAPID public key for Web Push (auto-generated + DB-stored fallback) |
| `VAPID_PRIVATE_KEY` | `push.js` | VAPID private key for Web Push (auto-generated + DB-stored fallback) |
| `VAPID_EMAIL` | `push.js` | `mailto:` VAPID contact (default: `mailto:admin@psycle.wingfield.tech`) |
| `RATE_LIMIT_TEST_FORCE` | `routes-normalized.js` | Test-only: enables the production-only read/refresh limiters so suites can assert 429s. |
| `ADMIN_PASSWORD` | `admin.js` | Password for admin panel login. If absent, all `/api/admin/*` routes return 503. |
| `APP_NAME` | `server/config.js` → all server modules + client via `/api/config` | App display name (default: `Sweat Assistant`). |
| `PUBLIC_HOST` | `server/config.js` → `calendar.js`, client via `/api/config` | Public domain for calendar feed URLs and UID generation (default: `psycle.wingfield.tech`). |
| `CORS_ORIGINS` | `server/config.js` → `server.js` | Comma-separated browser-origin allowlist for CORS. Defaults to `https://$PUBLIC_HOST` + `http://$PUBLIC_HOST`. |
