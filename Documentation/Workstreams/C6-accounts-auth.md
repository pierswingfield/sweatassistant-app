# C6 — Accounts and auth

**Priority:** P2 · **Size:** ~2–3 days · **Depends on:** a mail sender (part of C6-1) · **Blocks:** nothing

> **Verify first:** before changing anything for an item, confirm its basis in the code **and**, for anything user-visible, **in a real browser** (CDP :9222 or Claude for Chrome). For server-only items, use a failing test or a request. Record the evidence. If a browser check is needed and no browser is available, stop with `BLOCKED`. See [AGENT_PROTOCOL.md](AGENT_PROTOCOL.md).

Sweat Assistant accounts have their own identity, separate from gym credentials [D4]. Recovery
through a gym login was built and then rejected, because it re-coupled the two [D5]. The interim
is an admin reset.

| # | Item | Evidence (verified 2026-09-26) | Est. |
|---|---|---|---|
| C6-1 | **Self-service account recovery.** Only `POST /api/admin/users/:id/reset-password` exists. Mechanism **decided 2026-09-26: emailed single-use reset link** (see below). | `server/admin.js` ~L301–319 ("Self-service recovery does not exist") | ~1.5–2 days |
| C6-2 | **Change account email.** No endpoint exists. | No `change-email` or `updateUserEmail` anywhere | 3–4 h |
| C6-3 | **Legacy short passwords.** Legacy accounts keep sub-8-character passwords. Prompt an upgrade on next login, and show admins which accounts are affected. | `server/db.js` ~L1071 `setAccountPassword` (no re-check, by design) | 2–3 h |
| C6-4 | **Track background relogin failures.** Count consecutive failures per user and gym. Surface them in admin, and stop retrying after N attempts so a bad password can't lock the upstream account. | `server/auth.js` L346/370 only set `needs_relogin` | 2 h |

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

**Detail:** [archived BACKLOG "Account recovery" and "Account setup"](../Archive/2026-09-26/BACKLOG.md).
