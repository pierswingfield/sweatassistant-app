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

Postgres and per-user key derivation are listed in C7.
