# C6 — Accounts and auth

> **Archived 2026-10-08.** C6-1 and C6-2 are deferred to the [central backlog](../../Workstreams/BACKLOG.md); completed items remain here as history.

**Priority:** P2 · **Size:** ~2–3 days · **Depends on:** a mail sender (part of C6-1) · **Blocks:** nothing

> **Verify first:** before changing anything for an item, confirm its basis in the code **and**, for anything user-visible, **in a real browser** (CDP :9222 or Claude for Chrome). For server-only items, use a failing test or a request. Record the evidence. If a browser check is needed and no browser is available, stop with `BLOCKED`. See [AGENT_PROTOCOL.md](../../Workstreams/AGENT_PROTOCOL.md).

Sweat Assistant accounts have their own identity, separate from gym credentials [D4]. Recovery
through a gym login was built and then rejected, because it re-coupled the two [D5]. The interim
is an admin reset.

| # | Item | Evidence (verified 2026-09-26) | Est. |
|---|---|---|---|
| C6-1 | **Self-service account recovery.** Only `POST /api/admin/users/:id/reset-password` exists. Mechanism **decided 2026-09-26: emailed single-use reset link** (see below). | `server/admin.js` ~L301–319 ("Self-service recovery does not exist") | ~1.5–2 days |
| C6-2 | **Change account email.** No endpoint exists. | No `change-email` or `updateUserEmail` anywhere | 3–4 h |
| C6-3 | ❌ **CLOSED 2026-10-06 (won't do: no legacy accounts on prod).** Legacy short passwords in old accounts were a migration concern only. Prod launched with a fresh DB, so this is not needed. | — | — |
| C6-4 | ✅ (2026-09-28) **Track background relogin failures.** Count consecutive failures per user and gym. Surface them in admin, and stop retrying after N attempts so a bad password can't lock the upstream account. | `server/auth.js` L346/370 only set `needs_relogin` | 2 h |

Copy fixes on the recover screen are in C1-4 and U1-4.

## C6-1 decision (2026-09-26): emailed single-use reset link

The account email is already the login ID (`users.email UNIQUE NOT NULL`), and the server has no
mail sender yet.

| Option | Verdict |
|---|---|
| **Emailed reset link** via a transactional mail API | **Chosen.** It's the standard pattern users expect. The same mail sender also covers C6-2, where the new address must be verified. |
| Cloudflare Access identity | Rejected. Prod is public and not behind Access, so it only works for the admin. |
| Recovery codes shown at signup | Rejected as the primary route. Users lose them. Could be a later add-on. |
| Recovery through a gym login | Already rejected [D5]: it re-couples SA accounts to gym passwords. |

Shape of the build:

1. Add a mail sender: a transactional API such as Resend or Postmark, or SMTP from the existing
   domain. Keys go in `.env` only.
2. `POST /api/auth/forgot`: always returns 200 (it doesn't reveal whether an account exists) and is
   rate-limited per IP and per email. It stores a **hashed**, single-use token that expires after
   30 minutes.
3. `POST /api/auth/reset` with the token and a new password (8+ characters). It consumes the token
   and revokes existing sessions.
4. **Keep the stored gym credentials by default.** Proving the mailbox is stronger than the admin
   path, which clears them. The user can still unlink.
5. Admin reset stays as the fallback. Add a "verify email" step at signup so resets reach a real
   inbox. Existing accounts are verified on their first successful reset.

**Detail:** [archived BACKLOG "Account recovery" and "Account setup"](../2026-09-26/BACKLOG.md).

## C6-4 — background relogin failures (done 2026-09-28)

- **Basis:** `server/test-relogin-failures.js` written first and red 5/5 against the old code: `auth.js`
  `triggerAutoRelogin` only set `status = 'needs_relogin'` on failure (auth.js L346/L378); nothing counted
  attempts and nothing stopped them.
- **Root cause:** the scheduler, poller and calendar cron all call `triggerAutoRelogin` on every 401. After
  a failure the session is cleared but the stored credential remains, so the next 401 re-submits the same
  rejected password to the member's real gym account, indefinitely.
- **Fix:**
  - `db.js` `user_gyms` gets `relogin_failures`, `relogin_rejections`, `relogin_suspended`,
    `last_relogin_failure_at`, `last_relogin_error`; `recordReloginFailure` / `clearReloginFailures`;
    `getUserGymsPublic`, `getAllUsers` (`relogin_issues`, every linked gym) and `getUserDetail.gyms` expose them.
  - `auth.js` `triggerAutoRelogin` records each failed renewal; after `RELOGIN_MAX_REJECTIONS = 3`
    consecutive **credential rejections** (message match `rejected your login` etc.) the link is suspended and
    later calls fail fast with `GYM_SESSION_EXPIRED` + `reloginSuspended` without contacting the gym. A
    provider outage counts toward `relogin_failures` (visible to the admin) but never suspends, so a gym
    downtime cannot strand members. Success, a re-link (`linkGymAccount`) or an admin credential reset
    (`resetGymCredentials`) clears the counters.
  - `admin.html`: a pill per affected gym under the email in the user list (red = paused, muted = still
    retrying) and a per-gym line in the detail "Linked gyms" section with count, time and last error.
- **Tests:** `test-relogin-failures.js` 5/5 (per user+gym counting and reset, suspension with zero upstream
  calls, outage never suspends, re-link clears, admin list and detail gym-aware).
- **Real browser (Chrome 154, CDP :9222, one tab, local mock server with a scratch DB, admin password set):**
  `/admin` user list rendered `JAB Boxing Club: 3 relogin fails · paused` (class `pill pill-red`) and
  `Psycle London: 2 relogin fails` (`pill pill-muted`) on the affected account and nothing on the healthy
  one; the detail drawer showed `3 consecutive relogin failures · auto sign-in paused ... JAB rejected your
  login: incorrect email/password` and the Psycle line. Admin localStorage cleared afterwards.
- **Not done:** no user-facing prompt beyond the existing `needs_relogin` status; the number 3 is untuned.
