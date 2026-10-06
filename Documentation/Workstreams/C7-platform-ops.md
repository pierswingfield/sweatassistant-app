# C7 — Platform, ops and security hardening

**Priority:** P1 for the pre-launch subset, P2–P3 for the rest · **Size:** ~1 day pre-launch, then ~1 week
**Depends on:** nothing · **Blocks:** C4 (pre-launch subset only)

> **Verify first:** before changing anything for an item, confirm its basis in the code **and**, for anything user-visible, **in a real browser** (CDP :9222 or Claude for Chrome). For server-only items, use a failing test or a request. Record the evidence. If a browser check is needed and no browser is available, stop with `BLOCKED`. See [AGENT_PROTOCOL.md](AGENT_PROTOCOL.md).

## Pre-launch subset (do before C4 Stage B)

| # | Item | Evidence (verified 2026-09-26) | Est. |
|---|---|---|---|
| C7-1 | **Rate-limit the normalized read routes.** `extrasLimiter` covers only `/bundles`, `/bookmarks` and `/profile/update`. `/timetable`, `/metadata` and `/bookings` are unlimited, and each can fan out to upstream providers. | `server/routes-normalized.js` ~L509 | 1–2 h ✅ **Done 2026-09-27** |
| C7-2 | **Build-stamp the service worker cache name.** It's hand-versioned (`psycle-cache-v2`), so a forgotten bump ships stale JS. This is the "prod deploy cache gotcha". The `activate` handler already cleans old caches. | `client/public/sw.js` L54–55 | 1 h ✅ **Done 2026-09-27** |
| (C1-5) | SQLite backups: tracked in C1 because it's urgent regardless of launch. | | |

---

### C7-1 — done 2026-09-27

**Root cause.** `server/routes-normalized.js` had exactly one rate limiter (`extrasLimiter`,
~L518 pre-fix), mounted only on `/bundles`, `/bookmarks` and `/profile/update`. Every other
GET on the normalized surface — `/my-gyms`, `/timetable`, `/metadata`, `/events/:id`,
`/studios/:id/layout`, `/cancel-penalty/:bookingId`, `/bookings`, `/waitlists`, `/profile`,
`/credits`, `/eligibility`, `/membership` — had no limiter middleware at all. Confirmed by
grep (no `Limiter` hit on any of those route declarations) and by looping 150 authenticated
`GET /api/timetable` requests against the local dev server: 150/150 returned 200, none 429.

**Measured real-session read counts** (real Chrome via CDP :9222, `npm run dev`, logged in as
`dev@psycle.com` with both Psycle and JAB linked — a genuine two-gym account):
- Cold boot (full page load, no cache): **48** combined calls to `/api/`, including `/timetable`
  x2, `/metadata` x2, `/bookings` x2, `/waitlists` x2, `/profile` x1, `/credits` x3,
  `/eligibility` x3, `/my-gyms` x9. (A 2-gym merged view fires one request per linked gym per
  fetch, which is why several routes appear twice per logical "load".)
- One full pass through all 5 tabs (My Bookings → Auto-Book → Credits & Membership → Settings →
  back to Class Timetable), each tab given 2s to settle: **61** combined calls, including
  `/timetable` x2, `/metadata` x2, `/bookings` x4, `/waitlists` x4, `/profile` x2, `/credits` x3,
  `/eligibility` x6, `/membership` x2, `/my-gyms` x16 (the single busiest route — every
  tab/settings render re-checks the active gym).
- 3 rapid manual clicks on the timetable's refresh control (~4s): **6** calls to
  `/api/timetable?refresh=1` (2 per click, one per linked gym) — this is the path that bypasses
  `schedule-cache.js` and hits the provider directly.

**Fix.** `server/routes-normalized.js`:
- `readLimiter` (~L159, defined before first use) — **300 requests/min per user**, one shared
  counter across all twelve previously-unlimited GET routes listed above (mounted at each route
  declaration, e.g. L210 `/my-gyms`, L294 `/timetable`, L330 `/metadata`, L485 `/profile`,
  L502 `/credits`, etc.). ~4x headroom over the measured 5-tab-tour peak (~73 combined /
  ~16 single-route). Per-user (not per-IP), same `keyGenerator` pattern as `extrasLimiter`.
  Production-only (`skip`), matching every other limiter in this codebase.
- `refreshLimiter` (~L178) — a tighter **30 requests/min per user**, applied only when
  `req.query.refresh === '1'`, mounted ahead of `readLimiter` on `/timetable` and `/metadata`
  (the only two routes that support the bypass). ~5x headroom over the measured 6-in-4s burst.
- Testability: both limiters check `process.env.RATE_LIMIT_TEST_FORCE === '1'` in addition to
  `NODE_ENV === 'production'`, so a test can force them on while staying in `development` mode —
  necessary because the dev@psycle.com mock login (`providers/codexfit.js`) is itself gated
  `NODE_ENV !== 'production'`, so a production-mode child process can't reach the mock backend
  at all.

**Test.** `server/test-rate-limit-reads.js` (new, auto-discovered by `run-tests.js`). Boots the
real server 3x as a child process (mirrors `test-regression-psycle.js`), logs in as
dev@psycle.com, and asserts: (1) `/api/timetable` returns 429 once the 300/min budget is
exceeded (tripped at request #301); (2) `/api/bookings` and `/api/my-gyms` are ALREADY 429
after that same burst — proving the budget is one shared per-user counter across routes, not
per-route; (3) `?refresh=1` trips its own 30/min budget independently (at request #31); (4)
without `RATE_LIMIT_TEST_FORCE`, dev mode stays fully unlimited (150/150 → 200), confirming the
production-only gate still holds. `node server/test-rate-limit-reads.js` passes standalone and
via `npm test` (32/32 server suites).

**Client.** `client/src/api.js` `apiFetch()` only special-cases `res.status === 401` (SA logout)
and `res.status === 403` with a gym header (unlinked-gym warning) — every other non-2xx status,
429 included, falls through to `return res;` unmodified, and callers check `res.ok` themselves
(e.g. `getTimetable()` throws `'Failed to load timetable'` on a non-ok response). Verified live:
with `RATE_LIMIT_TEST_FORCE=1`, burned a user's read budget via 320 direct fetches from the
page's own console, then clicked the real refresh button. Result: no logout, no crash, header
badges (`dev@psycle.com`, JAB/PSYCLE credit chips) stayed intact, the previously-cached
timetable stayed on screen; console showed
`[Timetable] Prefetch failed: Error: Failed to load bookings` and
`[App] Failed to refresh user credentials: Error: Failed to load profile` as the only visible
effect. **429 is not mishandled** — it degrades to "keep showing cached data" (or, with no cache
at all, the existing "No cached timetable available / Retry" panel), the same graceful path
every other read failure already takes. No toast is shown for this specific case today; given
the 4x/5x headroom sized above, a legitimate user should not realistically reach it, so adding
one is out of scope for this pass.

### C7-2 — done 2026-09-27

**Root cause.** `client/public/sw.js` L54–55 hand-versioned the cache names
(`psycle-cache-v2` / `psycle-assets-v2`). Confirmed by running `npm run build:client` twice in a
row and diffing `dist/sw.js`: byte-identical `CACHE_NAME`/`ASSETS_CACHE_NAME` both times — there
was never any per-build differentiation, so a forgotten manual version bump ships the old cache
name (and therefore the old cached shell/JS) forever, since the `activate` handler only deletes
caches NOT in its own whitelist and an unbumped name is trivially still "in" it.

**Fix.**
- `client/public/sw.js`: `CACHE_NAME`/`ASSETS_CACHE_NAME` now derive from a `BUILD_STAMP` const
  (`'__BUILD_STAMP__'` placeholder in source) and a gym-neutral `sweat-cache` prefix (was
  `psycle-cache`, product now serves more than one gym brand). `npm run dev` serves this file
  from `public/` unprocessed, so the placeholder stays literal there — still a stable, valid
  cache name, so dev mode is unaffected.
- `client/vite.config.js`: new `stampServiceWorker()` plugin (`apply: 'build'`), hooked on
  `closeBundle` (runs after Vite's own public-dir copy has placed `sw.js` in `outDir`). Replaces
  every `__BUILD_STAMP__` occurrence in the **built** `dist/sw.js` with a token unique to that
  build (`Date.now().toString(36)` + a random suffix). Two consecutive builds now produce
  different stamps (`muj3yicq-25zy0k` vs `muj3ykg2-a0objh` vs `muj434b3-tzrngq` — three separate
  builds during this pass, three different stamps).
- `activate` cleanup (L91–103, unchanged logic, confirmed correct): it's a whitelist
  (`CACHE_WHITELIST = [CACHE_NAME, ASSETS_CACHE_NAME]`, delete anything not in it), not a
  prefix match — but a whitelist already deletes MORE than a prefix match would, because it
  also catches the legacy hand-versioned names (`psycle-cache-v2`, `psycle-assets-v2`), which
  don't share the new `sweat-cache-*` prefix at all. No code change was needed there; added a
  comment recording why.

**Browser verification** (real Chrome via CDP :9222, one tab, closed at the end):
1. Found a **pre-existing stale SW registration on `localhost:3000`** from earlier
   local testing — cache key `psycle-cache-v2`, exactly the bug this item fixes. Unregistered
   it and cleared its CacheStorage as the starting state.
2. Built the client, copied `client/dist` → `server/public` (mirroring the Dockerfile's
   `COPY --from=client-builder /app/client/dist ./server/public`, since `server/public` is
   gitignored and wasn't being regenerated by any local npm script), started the server with
   `NODE_ENV=production`, loaded `http://localhost:3000`. Result: `caches.keys()` →
   `["sweat-cache-muj3ykg2-a0objh"]`, one SW registration, `state: "activated"`.
3. Rebuilt (new stamp `muj412x4-2pvn3z`), re-copied to `server/public`, restarted the server,
   reloaded the tab. Result: `caches.keys()` → `["sweat-cache-muj412x4-2pvn3z"]` only — the
   previous build's cache was gone, confirming the `activate` cleanup fires and removes the
   prior stamped generation automatically, with no old cache left behind.
4. Cleaned up: unregistered the SW and cleared CacheStorage on both `localhost:3000` and
   `localhost:5173` before closing the tab, per the browser-etiquette rule for this pass.

**Re-verify:** `npm run test:client` — 11 test files / 86 tests passed (untouched by this
change, confirms no regression). `npm run build:client` — clean build, `dist/sw.js` stamped
(`muj434b3-tzrngq`), no new warnings introduced (the four dynamic/static-import chunking
warnings are pre-existing and unrelated to this change).

## Later

| # | Item | Evidence | Est. | Pri |
|---|---|---|---|---|
| C7-3 | ✅ *done 2026-10-06* Structured JSON logging plus a `/metrics` endpoint. Admin actions currently have no audit log. | Only `console.log` and `/api/health` | 1 day | P2 |

> **C7-3 step 1 DONE 2026-10-06 (admin audit log).** Root cause: `admin.js` kept no durable record (only a `console.log` on reset-password). Added `admin_audit_log`, `db.recordAdminAudit`/`listAdminAudit`, calls from login success/failure, priority, delete, link-gym, reset-password and presentation update/reset, `GET /api/admin/audit`, an Audit log section in `admin.html`; test `server/test-admin-audit.js`. **C7-3 stays open:** step 2 structured JSON logging, step 3 `/metrics`.
>
> **C7-3 step 2 DONE 2026-10-06 (structured JSON logging).** Root cause: only free-text `console.*` (~451 calls), no request log, and nothing to count upstream `/events` calls from. Added `server/logger.js` (JSON lines, `LOG_LEVEL`, key-name redaction, Errors reduced to message), a request-log middleware in `server.js` (method, path without query, status, durationMs, userId; calendar token path scrubbed), and debug `provider call` lines from both adapters' real fetches (mock paths do not emit them). Converted 13 relogin/throttle sites in `auth.js`, `scheduler.js`, `poller.js`, `rate-limit-backoff.js`. **Remaining free-text `console.*` calls in non-test server code: 122** (convert later). Test: `server/test-logger.js`. Step 3 `/metrics` still open.
>
> **C7-3 step 3 DONE 2026-10-06 (`/metrics`), so C7-3 is fully DONE.** Root cause: no metrics, only the `/api/health` JSON. Added `server/metrics.js` (hand-rolled registry, no prom-client) and `GET /metrics` gated by `METRICS_TOKEN` bearer or admin JWT (401 none, 403 wrong, 503 unconfigured). Series: HTTP count and duration by route template and status class, provider calls by gym/platform/outcome, schedule-cache hit/stale/miss, pending queue, next release, heartbeat ages, backoff-active per gym, uptime and memory. Label bounds are in the `metrics.js` header. Test: `server/test-metrics.js`.
| C7-4 | Instructor image proxy and resize, so the client doesn't hotlink full-size provider images. | No image route | 3–4 h | P3 |
| C7-5 | Per-user AES key derivation. Today one global key encrypts every user's gym credentials. | `server/crypto.js` L20 | 0.5 day plus a migration | P3 |
| C7-6 | Migrate SQLite to Postgres. Not needed at current scale. | — | 2–3 days | P3 |
| C7-7 | Proactive occupancy warming poller. **Re-evaluate after C2-5**: `/heartbeat` invalidation probably makes this unnecessary. | `schedule-cache.js` is reactive SWR only | — | P3 |
| C7-8 | ✅ *pulled forward into launch 2026-09-28, done* Retire the stale `deploy.sh`, which still targets the Pi. The real deploy is rsync plus `docker compose up -d --build` on oracle. | Registry note | 15 min | P3 |

## C7-8 — stale `deploy.sh` retired (pulled forward into launch 2026-09-28) — DONE

- **Basis:** the old `deploy.sh` targeted `pi@192.168.1.8:/home/pi/psycleapp`, ran `sudo docker compose down`
  then `up`, and generated a new `.env` (with `PUBLIC_HOST=psycle.wingfield.tech`) if none existed on the
  target. Both environments have lived on oracle since 2026-08-03 (registry: `psycleapp`, `psycleapp-dev`).
  TESTING.md said 16 server suites and AGENTS.md said 17; `ls server/test-*.js` gives 38.
- **Fix:** `deploy.sh` rewritten: rsync to `oracle:~/services/psycleapp-dev/` (default) or `psycleapp/`
  (`--prod`), excluding `.env`, `.env.*`, `data/`, `node_modules`, `client/dist`, `server/public`, `.git`
  and `*.db*`, then `docker compose up -d --build` and `ps` over ssh. It never writes `.env`. Prod needs
  `--prod`, an interactive terminal and the typed phrase `deploy prod`. `--print` shows every command and
  runs nothing. For prod it also excludes `docker-compose.yml`, because the repo's compose file is the dev
  twin's (container `psycle-app-dev`, tailnet bind) and must not overwrite prod's own.
- **Docs:** TESTING.md and AGENTS.md suite counts corrected to 38; AGENTS.md project-structure line for
  `deploy.sh` updated.
- **Verified:** `bash -n`; `--print` for dev and prod (prod list adds the compose exclusion); `--prod` with
  no tty exits 1; `--prod` on a pty with a wrong answer prints "Aborted." and exits 1; unknown flag exits 2.
  The script was deliberately NOT run against oracle (out of scope for this pass).
- **Unverified:** that the login user on oracle can run `docker` without sudo (override with
  `DEPLOY_DOCKER="sudo docker"`), and that prod's remote compose file is not the repo's. No `--delete`, so
  a file removed from the repo lingers on the host until removed by hand.
