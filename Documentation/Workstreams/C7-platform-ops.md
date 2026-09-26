# C7 — Platform, ops and security hardening

**Priority:** P1 for the pre-launch subset, P2–P3 for the rest · **Size:** ~1 day pre-launch, then ~1 week
**Depends on:** nothing · **Blocks:** C4 (pre-launch subset only)

> **Verify first:** before changing anything for an item, confirm its basis in the code **and**, for anything user-visible, **in a real browser** (CDP :9222 or Claude for Chrome). For server-only items, use a failing test or a request. Record the evidence. If a browser check is needed and no browser is available, stop with `BLOCKED`. See [AGENT_PROTOCOL.md](AGENT_PROTOCOL.md).

## Pre-launch subset (do before C4 Stage B)

| # | Item | Evidence (verified 2026-09-26) | Est. |
|---|---|---|---|
| C7-1 | **Rate-limit the normalized read routes.** `extrasLimiter` covers only `/bundles`, `/bookmarks` and `/profile/update`. `/timetable`, `/metadata` and `/bookings` are unlimited, and each can fan out to upstream providers. | `server/routes-normalized.js` ~L509 | 1–2 h |
| C7-2 | **Build-stamp the service worker cache name.** It's hand-versioned (`psycle-cache-v2`), so a forgotten bump ships stale JS. This is the "prod deploy cache gotcha". The `activate` handler already cleans old caches. | `client/public/sw.js` L54–55 | 1 h |
| (C1-5) | SQLite backups: tracked in C1 because it's urgent regardless of launch. | | |

## Later

| # | Item | Evidence | Est. | Pri |
|---|---|---|---|---|
| C7-3 | Structured JSON logging plus a `/metrics` endpoint. Admin actions currently have no audit log. | Only `console.log` and `/api/health` | 1 day | P2 |
| C7-4 | Instructor image proxy and resize, so the client doesn't hotlink full-size provider images. | No image route | 3–4 h | P3 |
| C7-5 | Per-user AES key derivation. Today one global key encrypts every user's gym credentials. | `server/crypto.js` L20 | 0.5 day plus a migration | P3 |
| C7-6 | Migrate SQLite to Postgres. Not needed at current scale. | — | 2–3 days | P3 |
| C7-7 | Proactive occupancy warming poller. **Re-evaluate after C2-5**: `/heartbeat` invalidation probably makes this unnecessary. | `schedule-cache.js` is reactive SWR only | — | P3 |
| C7-8 | Retire the stale `deploy.sh`, which still targets the Pi. The real deploy is rsync plus `docker compose up -d --build` on oracle. | Registry note | 15 min | P3 |
