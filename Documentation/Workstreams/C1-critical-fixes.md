# C1 — Critical fixes (security, session, data safety)

**Priority:** P0 · **Size:** ~1 day · **Depends on:** nothing · **Blocks:** C4 launch

> **Verify first:** before changing anything for an item, confirm its basis in the code **and**, for anything user-visible, **in a real browser** (CDP :9222 or Claude for Chrome). For server-only items, use a failing test or a request. Record the evidence. If a browser check is needed and no browser is available, stop with `BLOCKED`. See [AGENT_PROTOCOL.md](AGENT_PROTOCOL.md).

Small, independent fixes. Each one is a real risk to users or data, not polish.

| # | Item | Evidence (verified 2026-09-26) | Est. |
|---|---|---|---|
| C1-1 | **Redact credentials in the event debug modal.** It `JSON.stringify`s raw event, booking and waitlist payloads with HTML-escaping only. Add a redaction pass for tokens, keys, emails and payment fields. [QA-22] | `client/src/ui/timetable.js` `openDebugModal` | 1–2 h |
| C1-2 | **One gym's 401 must not log out the whole app.** `apiFetch` treats any 401, including a single provider's, as a Sweat Assistant session expiry: it clears the SA token and fires logout. Route per-gym 401s to that gym's "needs relogin" state instead. [QA-08] | `client/src/api.js` ~L100–106 | 2–3 h |
| C1-3 | **Keep slot IDs as strings in spot selection.** `Number(slot.id)` breaks non-numeric IDs (MarianaTek) and any ID over 2^53. [QA-13] | `client/src/ui/timetable.js` ~L2629 | 30 min |
| C1-4 | **Fix the crash in the account-recover screen.** `setAuthMode('recover')` references a `#psycle-recover-step2` element that doesn't exist, so it throws a TypeError. Also fix the subtitle, which still describes the removed gym-login recovery (belongs with U1-4, same lines). [QA-06, QA-05] | `client/src/main.js` ~L1260, L1275 | 30 min |
| C1-5 | **Back up the SQLite DB.** No backup job exists for prod or dev. The DB holds encrypted gym credentials, and it is only snapshotted by hand before deploys. Add a nightly job that copies `.db` **plus `-wal`/`-shm`**, or runs `sqlite3 .backup`, off the host (rclone → Drive, as the other services do). | No `scripts/`; nothing in `docker-compose.yml`. The registry notes manual `.bak` copies only. | 1–2 h |

## Done when

- [ ] Each fix has a unit or server test where one is practical (C1-1 redaction and C1-2 401
      routing are both unit-testable).
- [ ] `npm test` is green.
- [ ] Deployed to the dev twin. Smoke test: expire one gym's token on a two-gym account and
      confirm you stay logged in and only that gym shows "reconnect".
- [ ] A backup file restores on a scratch container.

**Detail:** [QA 2026-09-15 ISSUES](../QA/browser-runs/2026-09-15-local-mock/ISSUES.md),
[QA 2026-09-23 ISSUES](../QA/browser-runs/2026-09-23-lane-live/ISSUES.md).
