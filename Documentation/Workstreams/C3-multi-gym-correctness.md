# C3 — Multi-gym correctness

**Priority:** P1 · **Size:** ~3 days · **Depends on:** nothing (can run in parallel with C2)
**Blocks:** C4 launch

> **Verify first:** before changing anything for an item, confirm its basis in the code **and**, for anything user-visible, **in a real browser** (CDP :9222 or Claude for Chrome). For server-only items, use a failing test or a request. Record the evidence. If a browser check is needed and no browser is available, stop with `BLOCKED`. See [AGENT_PROTOCOL.md](AGENT_PROTOCOL.md).

The server-side "active gym" bug class was removed on 2026-09-16
([audit](../Archive/2026-09-26/Backlog/active-gym-audit.md)). What remains: the client's
equivalent, a few read-side leftovers, and the bugs the 2026-09-23 live run found against real
Psycle and JAB accounts.

## Live-run bugs (2026-09-23)

| # | Item | Evidence (verified 2026-09-26) | Est. |
|---|---|---|---|
| C3-1 | **Link/unlink a gym updates the app without a reload.** Settings re-renders its own cards but never refreshes the global gym context, so header badges and the timetable stay stale. [QA-09] | `client/src/ui/settings.js` link ~L1439 and unlink ~L1211 don't call `loadGymContext`/`setLinkedGyms` | 2 h |
| C3-2 | **Unmetered gym (JAB) open-class button reflects membership state.** Currently it shows a credits-style state that doesn't apply. [QA-16] | `client/src/ui/timetable.js` `buildActionModel` | 2–3 h |
| C3-3 | **The header "Member" badge checks actual membership.** It shows whenever a gym is unmetered, even when the account has no active membership. [QA-17] | `client/src/main.js` `renderGymBadge` ~L555–573 | 1 h |
| C3-4 | **Studio map editor in Settings is gym-scoped.** It falls back to an unscoped `cache.locations` when opened for a gym that isn't the context gym, so it can show another gym's rooms. [QA-18] | `client/src/ui/settings.js` ~L711–723 | 1–2 h |
| C3-5 | **Push notifications name the right gym.** Every title and body hardcodes "Psycle" ("Psycle: Spot Booked", "speak to Psycle…"). [QA-20] | `server/notifications.js` L101–144 | 1 h |

## Structural leftovers

| # | Item | Evidence | Est. |
|---|---|---|---|
| C3-6 | **Remove the client's ambient gym-context fallback.** The module-level `state` plus `setGymContext()` is the client twin of the server bug class deleted on 09-16. Anything reading it on a multi-gym account gets a guess. Make every consumer pass an explicit gym. | `client/src/gym-context.js` L27–60 | 1 day |
| C3-7 | `db.getAllUsers()` joins `user_gyms` on the literal `DEFAULT_GYM_ID`, so admin lists show Psycle data only. | `server/db.js` ~L1541–1555 | 1 h |
| C3-8 | Admin user detail: add a gym picker. `getUserDetail` resolves one ambient gym, so a JAB-only or second-gym view isn't possible. | `server/admin.js` L123; `db.js` ~L1565–1608 | 2 h |
| C3-9 | Remove the hardcoded Psycle booking-window helpers from the shared client lib (`getNextMondayNoonLondon`). Use the per-gym policy the server already exposes. | `client/src/lib.js` L188, imported by `timetable.js` | 2 h |
| C3-12 | **Background auto-book uses the ACTIVE gym's session, not the row's gym.** `scheduler.js bookSlotWithRelogin(userId, gymId, …)` reads `db.getUserById(userId).jwt`, which resolves the user's *active* gym; neither `scheduler.js` nor `poller.js` wraps per-row work in `db.runWithGymContext`. So a JAB queue entry for a user whose active gym is Psycle is sent with Psycle's token and is expected to 401, then relogin for JAB. Check `poller.js` for the same pattern. Found 2026-09-26 during C2-3, code-confirmed and not yet reproduced. **Blocks C4 JAB launch.** | `server/scheduler.js` L361–374 | 1–2 h |

## Error handling / copy

| # | Item | Evidence | Est. |
|---|---|---|---|
| C3-10 | An account with no linked gym (409 `NO_GYM_LINKED`) shows a "Failed to load filters metadata" error toast. Treat it as the normal empty state. [QA-01] | `client/src/ui/timetable.js` ~L299 | 30 min |
| C3-11 | The invalid-credentials error should name the gym that failed ("JAB rejected your password"). [QA-04] | `server/providers/codexfit.js` ~L157; `routes-normalized.js` ~L171 | 30 min |

## Done when

- [ ] Each fix has a test where practical. C3-6 should add a guard test, as
      `test-no-active-gym.js` does for the server.
- [ ] Re-run the affected rows of the 09-23 live matrix on the dev twin with the two-gym test
      account.
