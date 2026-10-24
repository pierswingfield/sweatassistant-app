# Work plan: user-facing MCP server

**Status:** Proposed, 2026-10-24. Expands F-4, the user-facing MCP integration. No endpoint, credentials or public service has been created.

## Outcome and delivery recommendation

Let a member connect an AI client to their Sweat Assistant account, discover linked gyms, ask about classes/bookings/credits, and eventually request tightly controlled booking actions. Account identity remains local to Sweat Assistant; gym credentials stay on the server. A model must not gain an unrestricted gym API proxy.

Deliver a remote, OAuth-authorized **read-only pilot first**, then guarded immediate writes, then separately authorized automation. Use Streamable HTTP at a dedicated endpoint with a tested protocol revision/client/SDK combination. The [archived MCP proposal](../Archive/2026-09-26/Backlog/mcp-ai-server.md) is historical context: its legacy SSE endpoints, PAT-first remote authorization and `confirm: true` safety check are not the default design for this implementation.

Current standards and security references are captured in [MCP security research](mcp-security-research.md). Re-check the chosen protocol and SDK at implementation time; do not assume every AI client supports the newest revision or the same authorization methods.

## Verified code starting points

- `server/routes-normalized.js` owns normalized class, booking, waitlist, credit and account routes. Providers remain the only platform-aware layer; gym policy/capability flags remain in gym config.
- `server/auth.js` issues existing application JWTs and establishes validated per-user gym context. Reuse local account authentication for the human authorization page, not application/gym tokens as MCP bearer credentials.
- Current normalized reads share 300 requests/minute/user; explicit refresh has 30/minute/user. These are UI-derived request budgets, not gym API quotas.
- `server/server.js` has a 10/minute booking mutation limiter on auto-book/upgrade creation and caps of 15 pending auto-books and 10 active upgrades per gym. The normalized immediate `/book`, `/cancel` and `/swap` declarations do not attach that limiter; verify the full request path and add shared enforcement before exposing writes.
- `server/schedule-cache.js` provides shared caching/single-flight; `server/rate-limit-backoff.js` provides per-gym cooldown. Map their actual callers and failure handling before choosing the enforcement seam. Existing protection is reusable material, not evidence that every new path is covered.

## Phase 1 — scope, compatibility and threat model

1. Choose the first one or two target AI clients with the user. Prove remote connection, OAuth consent, revocation and reconnect against the chosen revision before committing to the full tool catalog. Verify reverse-proxy/CDN behavior, origin/host checks, streaming where applicable and request limits.
2. Define actors and trust boundaries: anonymous caller, account, OAuth client/grant, linked gym, upstream provider, background jobs and administrator. Exercise cross-account/gym IDs, stolen/revoked tokens, prompt injection in gym data, malicious client metadata, repeated consent attempts, retry storms and conflicting requests.
3. Inventory each proposed tool's data sensitivity, permission, maximum fan-out, upstream calls, mutation side effects and background cost. Define explicit support per gym capability.
4. Decide launch population, allowed clients, grant lifetime and retention. Recommended pilot: invited accounts and registered/tested clients, with read permissions only and server-side feature flags by account/tool/gym.

**Exit:** a working compatibility spike, threat model and bounded read-only catalog. No public write tools at this stage.

## Phase 2 — authorization and user controls

- Treat MCP as an OAuth resource server. Implement the discovery/challenge metadata required by the chosen MCP revision, Authorization Code with PKCE, exact redirect URI matching, anti-CSRF state, and explicit consent showing client, scopes and permitted gyms. Evaluate a maintained authorization server/library against existing local account login; do not invent an OAuth dialect.
- Choose client registration/metadata support from the compatibility spike. Restrict metadata retrieval and redirects to prevent SSRF; do not blindly fetch arbitrary client-supplied URLs. A maintained auth component does not remove this boundary.
- Use short-lived audience-bound MCP access tokens. Validate issuer, audience/resource, expiry, client/grant and scopes on every request; enforce gym/account ownership again at tool execution. Store refresh credentials securely with rotation/reuse handling; store opaque high-entropy credentials as hashes where server lookup suffices.
- Keep MCP token verification separate from existing application JWT verification. Never accept gym access tokens or pass MCP/client bearer tokens upstream. Do not place bearer tokens in URLs, logs or model-visible results.
- Add Account → AI connections: connect instructions, per-client consent, least-privilege scopes, explicit gym selection, last used, expiry and revoke-one/revoke-all. New gym links are not automatically added to old grants. Gym unlink and account deletion invalidate access appropriately.
- Define behavior for password reset, credential compromise and account disablement. Revocation must take effect promptly even for an otherwise unexpired access token and in-flight connections; authorization is checked per operation, not just transport setup.

Proposed permissions: `schedule:read`, `account:read`, `automation:read`, `bookings:write`, `automation:write`. Final names are internal API design choices. Split cancellation/spot-swap permissions if pilot feedback warrants it. Read scopes can expose sensitive routines; obtain explicit consent and minimize returned account data.

**Exit:** security tests demonstrate isolation, consent, revocation and no token confusion; settings/consent UI has real-browser evidence.

## Phase 3 — shared application boundary and read-only tools

Extract only the application operations needed by the first tools from Express handlers into shared services. Both PWA routes and MCP call these services with an explicit authenticated actor, grant permissions and gym. Preserve validated `runWithGymContext` behavior until a deliberate refactor replaces it. Do not call Express handlers with fabricated requests or skip their validation by calling providers directly.

Start with `list_connected_gyms`, bounded `search_classes`, `get_class_details`, `get_my_bookings`, `get_credits` and `get_automation`. Each tool uses strict schemas and bounded outputs. Gym IDs must be explicit for gym-specific actions; multi-gym reads expand only to permitted linked gyms, with a small maximum fan-out and partial-result errors identified per gym.

Reuse normalized timezone-aware records, capability checks, shared cache, relogin and invalidation. Return local time plus offset/zone, freshness and stable IDs; never merge credits across gyms into a misleading spendable total. Do not expose raw provider payloads, credentials, account recovery actions, arbitrary HTTP/URL execution or client-controlled force-refresh. Treat external names/descriptions as untrusted data, not instructions.

**Exit:** pilot reads work in the selected clients and all sensitive reads remain isolated by account and gym. Resource subscriptions and a local stdio wrapper are later additions only if there is a demonstrated client need.

## Phase 4 — resource budgets and upstream protection

Use two admission layers: request/tool limits for inexpensive abuse protection, and budgets charged for actual upstream work. A single tool request can cause many paginated calls, relogins and per-gym expansions. Reserve a bounded cost before fan-out and account for each upstream attempt; cache hits should not cost the same as provider misses.

| Control | Proposed pilot starting point; not a provider-published quota |
|---|---|
| MCP tool calls | 60/minute/account, small burst; separate client/grant sub-budget |
| Provider reads caused by MCP | 6/minute/account/gym; cap concurrency at 2/account and 1/account/gym |
| Search bounds | At most 14 days and 2 permitted gyms/request; at most 50 records/page, bounded pagination and response bytes |
| Immediate writes, once enabled | 2/minute/account and one in-flight mutation/account/gym, plus duplicate-action suppression |
| Automation | Existing per-gym caps remain; add an account-wide ceiling and explicit creation/change budgets after measuring total polling cost |
| Aggregate gym/provider pressure | Configurable fleet and egress budgets, queue/deadline limits, cooldown and reserved capacity based on measurements before public launch |

Tune these values from the compatibility spike and mock load tests; do not probe live gym APIs to discover their maximum tolerated traffic. Add daily work ceilings so slow sustained abuse is bounded. Include user/client/grant and IP limits where relevant; a global gym budget prevents many accounts bypassing individual limits. Token creation or additional clients must not reset account budgets.

All upstream callers must participate in a common admission/backoff policy, including relogin, background refresh and retries. Reserve capacity for scheduled bookings and essential PWA actions; stop/defer optional MCP reads first. Bound queues and reject promptly with structured retry guidance rather than accumulating work. Honor provider `Retry-After`, add jitter and bounded retry counts, and never retry an ambiguous mutation blindly.

Keep counters coherent across worker instances and restarts, or explicitly constrain the pilot to one instance with a fail-closed strategy for unavailable budget state. Cache/single-flight must preserve user-specific data isolation. Add per-tool/per-client/per-gym metrics for upstream attempts, cache hits, rejects, latency and backoff, with bounded labels and no secrets.

**Exit:** mock load tests prove hard upper bounds on upstream traffic and background work, and demonstrate that an abusive MCP client cannot starve scheduled jobs or bypass limits through the PWA path.

## Phase 5 — guarded booking actions

1. Add a preparation operation returning the exact action, gym, local date/time, spot, credits/eligibility, penalty/cancellation policy and a short-lived action ID. Revalidate ownership, capability and current eligibility on execution.
2. Obtain approval through an authenticated first-party UI tied to the account and exact action. A model supplying `confirm: true`, a client claiming approval, or a tool annotation is not proof of human consent. Bind approval to a canonical action digest, account, grant and expiry; consume once atomically. Re-approval is required if material terms change.
3. Persist action/idempotency state and serialize conflicting actions across clients/PWA where necessary. On timeout or lost upstream response, return pending/unknown and reconcile by querying provider state before allowing a retry. Do not promise exactly-once execution where the gym API cannot guarantee it.
4. Pilot self-booking, free cancellation, waitlist join/leave and supported atomic spot swaps separately. Unknown penalties fail closed. No payments, guest purchases, penalty-window cancellations or cancel/rebook swap fallback in the first write release.
5. Audit request, approval, execution and result using non-secret identifiers. Preserve cancellation/credit invariants and normalized errors. Provide a first-party activity view so users can understand and revoke access after an unwanted action.

**Exit:** mock adversarial/retry/race tests plus controlled acceptance for each supported provider and action. All live testing follows the [live verification playbook](../LIVE_VERIFICATION_PLAYBOOK.md), including its user-owned penalty tests and booking restrictions.

## Phase 6 — automation and rollout

Add queue-management tools only after immediate actions are reliable. New automation requires explicit approval of the rule, gym, classes, expiry, preferred/fallback spots, credit spending boundary and maximum pending work. Persistent automation is distinct from a one-time booking approval. Give users pause/stop controls and a notification trail; changing scope or expanding a rule needs new consent.

Define whether disconnecting an AI client stops its already-created background rules. Recommended default: stop pending client-created work unless the user explicitly retains it under their account. Preserve origin/ownership metadata so revocation can apply this choice without touching unrelated PWA-created automation. Revocation cannot undo an already-submitted upstream action; report such outcomes clearly.

Release sequence: internal/mock → invited read-only users → bounded read-only availability → invited approved writes → per-tool/gym wider writes → automation. Each step needs acceptance evidence, budget dashboards, abuse alerts, a kill switch and documented rollback. Disabling MCP must leave normal PWA operation available.

## Validation and decisions before implementation

Read [TESTING.md](../TESTING.md) before adding suites. Cover auth discovery/redirect/PKCE behavior, wrong audience/issuer, expired/revoked grants, cross-account/gym access, schema/size bounds, malicious provider text, metadata SSRF, batch/fan-out exhaustion, aggregate limits, provider 429s, retry storms, duplicate writes, uncertain outcomes and revocation during execution. Force rate enforcement in tests; do not rely on production-only limiter defaults. Run `npm test`, relevant build checks, actual selected AI-client interoperability tests and real-Chrome/iOS checks for the new UI.

Decisions needed at the first milestone: target clients; supported protocol revision; auth-server ownership; pilot population; write-approval UX; production fleet budget; whether automation survives disconnect; retention of grants/action/audit records. Recommended defaults above permit planning without pretending these choices are settled.

F-4, the MCP integration, remains a proposed backlog item until scheduled; this is its current plan rather than a second status register. The design refresh is not a prerequisite for server development. Its shared settings/modal components should be reused when adding consent and connection management.
