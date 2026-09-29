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

### Stage B — admin onboarding editor

Persist the validated contract and provide an admin flow for a new tenant on an
already-supported platform. It must validate the complete provider, policy and
presentation schema, test the connection without creating a booking, show a
generic preview in light and dark themes, and keep secrets out of the database
or UI response. A new platform still requires an adapter; this flow is for a
new gym on an existing platform.

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
