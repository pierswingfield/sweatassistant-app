# F — Future features

**Priority:** P2–P3 · Nothing here is scheduled. Each item has a written spec in the archive that
is still valid as a design starting point.

> **Verify first:** before changing anything for an item, confirm its basis in the code **and**, for anything user-visible, **in a real browser** (CDP :9222 or Claude for Chrome). For server-only items, use a failing test or a request. Record the evidence. If a browser check is needed and no browser is available, stop with `BLOCKED`. See [AGENT_PROTOCOL.md](AGENT_PROTOCOL.md).

| # | Feature | Depends on | Spec | Rough size |
|---|---|---|---|---|
| F-1 | **In-app 3-D Secure checkout.** When the bank asks for 3-D Secure, confirm the card in the app with Stripe.js instead of sending the user to the website. v2 carts expose `cart.metadata.stripe.secret`, which unblocks this. | C2-1, C2-G7 | [3d_secure_checkout.md](../Archive/2026-09-26/Backlog/3d_secure_checkout.md) | ~2 days |
| F-2 | **MarianaTek guest-pass booking.** `resolvePaymentOption` already accepts `forGuest`, but `book()` never passes it and no route exposes it. | C4 | [archived BACKLOG](../Archive/2026-09-26/BACKLOG.md) "Guest Pass Booking Flow" | ~1 day |
| F-3 | **Social class sharing.** Handles, a friend graph, "who's going", and iCal enrichment. | C4, C6 | [social-class-sharing.md](../Archive/2026-09-26/Backlog/social-class-sharing.md) | ~1 week |
| F-4 | **MCP server** (stdio and SSE), so AI assistants can query the timetable and book. | C4 | [mcp-ai-server.md](../Archive/2026-09-26/Backlog/mcp-ai-server.md) | ~3–4 days |
| F-5 | **MarianaTek credit purchase** for non-membership accounts, covering multi-studio chains. Open research: cart auth requirement, payment option shapes. [Q2, Q3, Q8] | C4 | [modular-gyms PROGRESS](../Archive/2026-09-26/Backlog/modular-gyms/PROGRESS.md) Q2/Q3/Q8 | research first |
| F-6 | Monitor the MarianaTek refresh-token hard-expiry window in production. [Q1] | C4 | [LIVE_VERIFICATION_PLAYBOOK](../LIVE_VERIFICATION_PLAYBOOK.md) T1-1 | observe |
| F-7 | **Gym onboarding and presentation contract.** First remove the two-gym client assumptions so a supported-platform gym can be added through config without editing `cards.js` or `styles.css`; then build the admin editor. The contract covers tenant URLs and ids, headers, capability flags, booking-window policy, timezone, brand assets/colours/short name, and display aliases. It needs validation plus a live "test connection" check against the backend. See [F-7 detail](#f-7--gym-onboarding-and-presentation-contract). Added 2026-09-29 at the user's request; expanded after the modularity assessment. | C4 | — | Stage A ~1–2 days; editor ~1 week |
| F-8 | **MarianaTek profile explorer.** Explore and expose the provider-specific profile/account data available to MarianaTek gyms, including JAB, with a clear normalized view where practical and raw/provider detail where needed for diagnosis. | C4, F-7 | — | research first |
| F-9 | **Gemini-powered booking and checking assistant.** Use the user's timetable, bookings, credits, preferences and related account data to answer questions and, within explicit user confirmation and safety gates, help check availability or initiate booking actions. | C4, F-8 | — | research first |
| F-10 | **Home page / Dashboard.** High-level summary view: classes this week counter, next upcoming class(es) with quick countdown/status, active auto-book count, aggregate credits summary across linked gyms, and quick-action shortcuts. Added 2026-09-29. | C4 | — | ~3–4 days |
| F-11 | **Class counts, stats, and historical insights.** Attendance analytics and milestones: total classes taken by gym/month/year, favorite instructors, concept breakdown (Ride vs Train vs Barre), streak tracking, and attendance trends computed from booking and calendar histories. Added 2026-09-29. | C4 | — | ~3–4 days |
| F-12 | **Gym-neutral favourites** for non-bookmark gyms (JAB/MarianaTek), keyed by studio + weekday + time. Psycle stays on native CodexFit bookmarks; enables Auto-Book Favourites data source. | C4, C5 | — | 3–4h build + ~1h browser check |
| F-13 | **Calendar / weekly view of bookings and waitlists.** Alternate view toggle in the "My Bookings" tab: switch between the vertical card list and an interactive 7-day calendar/weekly schedule grid showing active bookings, waitlists, and queued auto-books mapped by time across all linked gyms. Tap a slot to view details, swap spot, or manage. Added 2026-09-29. | C4 | — | ~2–3 days |
| F-14 | **SoulCycle gym integration.** Add SoulCycle as a third gym provider (`providers/soulcycle.js`). Bespoke PHP/monolith backend; requires cookie-jar auth (`SOULSESSION`), CSRF nonce pool management, studio HTML timetable scraping (or iOS app API reverse engineering), seat map normalization, and reserve/cancel endpoints. See [F-14 detail](#f-14--soulcycle-gym-integration) and [soulcycle.md](../Services/soulcycle.md). Added 2026-09-29. | C4, F-7 | [soulcycle.md](../Services/soulcycle.md) | ~1.5–2 weeks |
| F-15 | **Instructor photo proxy and cache.** Fetch each instructor photo once server-side, resize to WebP thumb/full, cache on disk and serve same-origin with immutable headers, so the PWA caches small readable responses instead of full-size opaque cross-origin images. See [F-15 detail](#f-15--instructor-photo-proxy-and-cache). Added 2026-09-29. | C4 | — | ~2–3h |

Postgres and per-user key derivation are listed in C7.

## F-7 — Gym onboarding and presentation contract

### Why this exists

The server-side modular-gym boundary is working: a gym selects a platform adapter
from `gyms.config.js`, and its tenant wiring, capabilities, booking-window policy,
timezone and notification defaults live in that one registry entry. The
`test-no-gym-privilege`, `test-gym-isolation` and `test-booking-window-policy`
suites enforce the most important parts of that boundary.

The client presentation boundary is only two-gym modular today. `cards.js`
branches on `id.includes('jab')`, embeds the JAB SVG and otherwise returns
Psycle assets/identity. `styles.css` mirrors those two ids in its tokens and
selectors. A supported-platform third gym would therefore need client code and
CSS edits for its wordmark, plate, row/card tint and settings mark. One JAB
studio alias (`RECOVERY 2.0` → `Recovery`) also lives in shared UI code. This
does not make MarianaTek or JAB part of core booking logic, but it means adding
a gym is not yet configuration-only from the user's perspective.

There is also a deliberately temporary client fallback in `lib.js`: if an event
has no server-stamped `releaseAt`, it recomputes Psycle's weekly release rule.
Normal normalized data is safe because the server supplies `releaseAt`; stale
or incomplete non-Psycle data must not be interpreted with Psycle policy.

### Stage A — remove the presentation and fallback coupling

1. Define a validated per-gym presentation contract in the registry. It must
   include a full and compact wordmark (or a text fallback), logo-plate colour,
   light/dark-safe ink/tint/on-colours, short display name, and scoped display
   aliases (for example, studio-name aliases). Keep provider protocol and
   booking policy separate from this presentation data.
2. Return that contract from `GET /api/gyms` and merge it into the linked-gym
   client context. Replace `gymBrand()`'s JAB/Psycle branch with a lookup by
   exact gym id and a neutral named fallback for unknown/missing brand data.
   **Status 2026-09-29: items 1 and 2 done (uncommitted).** Item 1: `node server/test-gym-presentation.js` passes under Node 20 (the earlier failure was a Node 26 `better-sqlite3` ABI mismatch, not a code bug). Item 2: `GET /api/gyms` returns `presentation`; `gym-context.js` gained `setGymCatalogue`/`getGymPresentation` (exact-id lookup); `gymBrand()` reads it, with a neutral text fallback and no `includes('jab')`. Chip/mark/rail plates now take the contract colour inline. Tests: `ui/gym-brand.test.js`, `gym-mark.test.js`; `npm test` 53/53 server, 166/166 client. Real Chrome (CDP :9222, local dev mock, Psycle + JAB linked): chips render `/gyms/jab-boxing.svg` on rgb(108,31,32) and Psycle AVIFs on rgb(33,33,33), zero neutral fallbacks. Styles.css still has per-id blocks (item 3).
   **Item 3 done 2026-09-29 (uncommitted).** Root cause: `styles.css` held `--gym-psycle-london-*`/`--gym-jab-boxing-*` tokens and ~12 per-id selectors. Now `gym-context.js gymPresentationCss()` injects `--gym-<id>-*` tokens (dark, prefers-light, `data-theme=light`) plus `[data-gym="<id>"]` aliases to generic `--gym-ink/-tint/-on` from the contract; styles.css uses only `[data-gym]` and has no gym ids (neutral defaults at :root). Header badge now stamps `data-gym`; chips/marks/rail take the plate inline. Test: `gym-brand.test.js` (no ids in styles.css, third-gym CSS, unsafe id rejected). `npm test` 53/53 server, 169/169 client (Node 20). Real Chrome (CDP :9222, local mock, 500px): chip plates rgb(108,31,32)/rgb(33,33,33); header pills dark #818cf8/#a78bfa, light #18214d/#7c3aed; mobile cards tinted per gym. Desktop `tr` rows checked under item 4 (below).
   **Item 4 done 2026-09-29 (uncommitted).** Root cause: `cards.js displayStudioName()` held a JAB-specific `/^recovery\s*2\.0$/` regex applied to every gym. Now `gym-context.js getDisplayAlias(gymId, scope, name)` reads the owning gym's `presentation.displayAliases` (trimmed, case/space-insensitive key); `displayStudioName(gymId, name)` delegates; `timetable.js` passes `event.gymId`. Raw names untouched. Tests in `gym-brand.test.js` (JAB aliased; Psycle/third gym/undefined unchanged; cards.js has no id literal). Real Chrome (CDP :9222, mock, 1400px): 20 desktop `tr[data-gym]` rows, jab-boxing vs psycle-london computed backgrounds differ (per-gym tint works, no fix needed); 500px shows cards not rows. Live alias display not exercised: mock has no "RECOVERY 2.0" studio (unit-tested only).
3. Make the shared CSS consume generic per-gym custom properties or inline
   per-card variables. Remove the two fixed gym-id token blocks and selectors;
   a new gym must not require a stylesheet edit just to obtain a readable,
   distinct treatment.
4. Move presentation-only aliases out of shared helpers and apply them only
   for their owning gym. Keep raw provider names unchanged for lookups,
   floor-plan data and API calls.
5. Retire/migrate stale cached event shapes where possible. Until that is
   complete, only use the weekly client release fallback when the event is
   positively known to be a compatible rolling-weekly gym; otherwise resolve
   no release rather than guessing a Psycle instant.
   **Item 5 done 2026-09-29 (uncommitted).** Root cause: `lib.js getClassReleaseTime()` fell back to Psycle's Monday-noon rule for any event lacking `releaseAt`, and ~20 client call sites defaulted a missing gym to the literal `'psycle-london'`. Now the fallback runs only when `gym-context.js isRollingWeeklyGym(gymId)` (strict, no default-ON) is true; otherwise it returns `null` and callers degrade (timetable treats unknown as open, auto-book shows "Release time unknown", debug shows "unknown"). Literal fallbacks replaced by `getDefaultGymId()` (first linked, else first catalogue, else neutral). Guard test in `gym-brand.test.js` scans all client JS/CSS (comments stripped) for gym ids / `includes('jab')`; `lib.test.js` covers weekly, per-class, unlinked and no-gym cases. `npm test` 53/53 server, 174/174 client (Node 20). Real Chrome (CDP :9222, local mock, caches cleared, 1400px): 22 gym-stamped elements (13 psycle-london, 9 jab-boxing), zero page errors, Auto-Book tab loads. Not exercised live: a queued row with a missing release (queue empty on mock); unit-tested only.

### Stage B — admin onboarding editor

Persist the validated contract and provide an admin flow for a new tenant on an
already-supported platform. It must validate the complete provider, policy and
presentation schema, test the connection without creating a booking, show a
generic preview in light and dark themes, and keep secrets out of the database
or UI response. A new platform still requires an adapter; this flow is for a
new gym on an existing platform.

**Stage B done 2026-09-29 (uncommitted).** Root cause: presentation lived only in `gyms.config.js`, so changing a wordmark/colour/alias meant a code edit. Now admin-only routes (`server/admin.js`: `GET/PUT/DELETE /api/admin/gym-presentations[/:gymId]`, `POST .../validate`, `POST .../test-connection`) persist a validated override in `server_kv` (`gym_presentation_overrides`, re-applied and re-validated at boot by `db.js`; bad entries skipped). Only the presentation keys are whitelisted, using the same `validatePresentation`; protocol, headers, capabilities and booking policy stay in the registry, and responses carry no headers or credentials. Connection test calls only the adapter's unauthenticated `fetchMetadata(…, null)` (GET, 15s timeout), never books or logs in. Editor with light/dark preview is in `server/admin.html`, with no gym ids in its code. Tests: `server/test-admin-gym-presentation.js` (8 checks incl. spy proving only `fetchMetadata` runs). `npm test` 54/54 server, 174/174 client (Node 20). Real Chrome (CDP :9222, local server, admin login): invalid plate rejected with the validator message; edit updated both previews live, saved, appeared in public `/api/gyms`; test connection returned 7 locations/19 studios/111 instructors ("nothing booked"); reset restored registry values. Not covered: a fixture third gym end to end, and the wordmark image upload (paths must already exist under `/gyms/`).

### Outstanding after F-7

- **F-7-o1 (open):** `displayAliases` (e.g. JAB "RECOVERY 2.0" studio) is unit-tested only. The mock has no such studio; add one to `server/mock-marianatek.js` and do a real-browser check.
- **F-7-o2 (open):** A missing-release queue row (auto-book entry with no `release_at`/`start_at`) is unit-tested only. The mock queue is empty; needs a live/browser check.
- **F-7-o3 (open):** No end-to-end third fixture gym proves a new gym needs config only.
- **F-7-o4 (open):** Wordmark upload is not built in the admin editor; asset paths must pre-exist.
- **F-7-o5 (open):** The admin connection test only calls `fetchMetadata`; document that it does not verify login.

### Acceptance

- Adding a third fixture gym on CodexFit and one on MarianaTek requires only
  registry/config fixtures and assets, not conditional client code or CSS
  selectors keyed to its id.
- The timetable, cards, headers and Settings render each fixture with its own
  accessible name, readable light/dark treatment and safe generic fallback.
- Aliases affect display only and never change normalized IDs or provider data.
- An event without `releaseAt` for a non-rolling-weekly gym is not treated as
  open according to Psycle's schedule.
- Extend the source-level guard to cover client gym-id branching in brand and
  alias helpers, alongside the existing server `test-no-gym-privilege` checks.

## F-14 — SoulCycle gym integration

### Why this exists

SoulCycle is one of the premier boutique fitness studios in London and the US, but does not use a commercial SaaS backend (unlike Psycle/CodexFit or JAB/MarianaTek). Research conducted on 2026-09-29 confirmed that SoulCycle runs a custom in-house PHP platform. Adding SoulCycle to Sweat Assistant expands coverage to another major cycling brand, exercising the provider abstraction (`GymProvider`) on a non-REST, cookie-based architecture.

Full protocol reverse-engineering and endpoint specifications are documented in [Documentation/Services/soulcycle.md](../Services/soulcycle.md).

### Architecture & Implementation Scope

1. **Provider Adapter (`server/providers/soulcycle.js`):**
   - Implements `GymProvider` contract (`fetchMetadata`, `fetchClasses`, `fetchClass`, `book`, `cancel`, `getProfile`, `listWaitlists`, `joinWaitlist`, `leaveWaitlist`).
   - Manages stateful cookie sessions (`SOULSESSION`), persisting encrypted cookie jars in `user_gyms.session_token`.
   - Handles auto-relogin via `POST /login/` by pre-scraping `csrf_token` from `GET /signin/`.
2. **Timetable Ingestion & Normalization:**
   - Server-renders studio pages (e.g. `GET /studios/uk-london/`).
   - Ingests upcoming class rows via HTML parser (`cheerio`) or evaluates private mobile app endpoints (iOS app ID: `966733747`).
   - Normalizes into `NormalizedEvent` shape (`makeEvent`).
3. **Seat Map & Availability:**
   - Normalizes studio bike layout (`data-x`, `data-y`, `data-id`, `data-value`) into Sweat Assistant's 2D grid schema (`makeSlot`).
   - SWR cache and single-flight polling against `GET /find-a-class/poll-availability/?class=<classId>`.
4. **Booking & CSRF Engine:**
   - Obtains and maintains CSRF nonces (`window.soulcycle.noncePool`).
   - Performs precision reservations via `POST /find-a-class/reserve-bike/` with `seat_id`, `class_id`, and `csrf_token`.
   - Supports unreserve via `POST /profile/unreserve-class/`.
5. **Registry & Presentation:**
   - Add `soulcycle-london` to `gyms.config.js` with capability flags (booking, waitlists, spot selection; no in-app credit purchase initially).
   - Configure brand presentation via F-7 presentation contract (palette, logo plate, wordmark assets).

### Dependencies & Size
- **Depends on:** C4 (Promote modular), F-7 (Gym presentation contract).
- **Rough size:** ~1.5–2 weeks.

## F-15 — Instructor photo proxy and cache

### Why this exists

Photos go from the provider straight to the `<img>` at full size. CodexFit publishes one size (`photo`), so a ~26–52px avatar downloads the whole image. MarianaTek has `thumbUrl`, but `imageUrl` is still large. `client/public/sw.js` (~line 135) already caches cross-origin photos cache-first, but the responses are **opaque** (`no-cors`): the SW cannot read the status, so a bad response can be cached and cannot be told from a good one. Cache size is also unknown.

Verified 2026-09-29: `sharp` is not installed; `normalize.js` (~line 108) maps `imageUrl`/`thumbUrl` straight from the provider; `instructorAvatar()` in `tooltips.js` consumes them.

### Design

1. `npm i sharp` in `server/` (prebuilt ARM64 binaries; oracle is aarch64).
2. New route `GET /api/instructor-photo/:gymId/:instructorId?size=thumb|full&v=<source-url-sha256>`. Resolve the upstream URL **from the provider's own instructor list**, never from a client-supplied URL. A first request waits up to 5 seconds for a 96px (quality 78) thumb or 480px (quality 82) full WebP; failure is a 404 so the client renders initials, never the original image.
3. Cache file key = hash of the upstream URL plus variant. The normalizer emits that hash as `v`, so an unchanged URL serves directly from disk with no provider call; a changed provider URL yields a new immutable URL on the next metadata refresh. The disk cache is global, capped at 500 MB with mtime-LRU eviction; there is no per-gym quota.
4. `providers/normalize.js`: rewrite `imageUrl`/`thumbUrl` to point at the route. The client reads only `Normalized*` fields, so `instructorAvatar()` and the tooltip need no change. Gym-agnostic: no platform branching (WP-D7).
5. `sw.js`: point the image rule at the same-origin route; cache only `200`s; keep it bounded.

### Constraints

- **SSRF:** allowlist by lookup, as above. Same principle as the removed `/api/proxy`.
- **Auth:** `<img>` cannot send the JWT and the photos are already public, so the route is unauthenticated. Rate-limit it at 180 requests/minute/IP, reject redirects, allow only JPEG/PNG/WebP/GIF/AVIF, and cap upstream bodies at 5 MB.
- **Persistence:** cache files live at `/data/instructor-photos`, under the existing Docker volume. The cache is disposable: an unavailable/full volume still returns a just-generated image but cannot retain it.
- **Single-flight** concurrent misses for the same photo, as `schedule-cache.js` does.
- **Failure:** upstream error or non-image returns 404 and is not cached; the client swaps the failed proxy image to initials and never retries a provider URL.
- **MarianaTek:** there is no instructor endpoint. Use the documented public `/classes?instructor=<id>` lookup across the next 90 days; no matching upcoming class means initials.
- **Browser cache:** the service worker caches only same-origin `200` photo responses, cache-first, bounded to 160 entries. The disk cache remains authoritative; cache health/hits/misses, upstream latency/failures, and disk usage are exposed in `/api/health`.
- Add the route to `test-no-gym-privilege` scope (no gym-id literals).

### Acceptance

- Real browser (CDP :9222): Network panel shows avatars as same-origin `image/webp`, thumb under ~10 KB, and a repeat load is served from cache with no upstream request.
- Server test: unknown instructor id returns 404; cross-gym id collision returns the right gym's photo; non-image upstream is not cached.
- Post-deploy cache check per the prod-deploy cache gotcha (SW + CacheStorage + IndexedDB all cleared).

### Dependencies & Size
- **Depends on:** C4 (deploy path). **Rough size:** ~2–3h.
