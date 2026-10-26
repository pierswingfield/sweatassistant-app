# MCP server implementation

**2026-10-25: general-release access-policy candidate; staged RC2 remains separate.** Current user scope and ordered follow-ups are in the [delivery plan](PLAN-mcp-server.md). Undeployed source now adds default-on account/gym read eligibility with audited admin overrides, one concurrent validated MCP execution per user and a shared fresh normalized-response cache. Deployment/provider switches and existing grant boundaries remain unchanged; New consent explicitly covers all current/future linked gyms while legacy grants retain their snapshot. A default-off write preference and separate bookings:write scope are implemented; guarded action execution remains unavailable pending the next implementation. Existing ChatGPT/Safari/bounded-read evidence is retained; Claude remains deferred/unverified.

## General access-control slice (undeployed)

The product read-eligibility default is on for existing/future accounts and configured attached gyms. Independent deployment/provider switches remain default-off; eligibility alone does not activate egress. Additive `mcp_account_access`/`mcp_gym_access` tables persist only admin overrides. Authenticated admin GET/PUT `/api/admin/users/:id/mcp-access` and `/api/admin/gyms/:id/mcp-access` accept only a boolean `enabled`, reject missing targets/extra fields and audit changes. There is no read-access user setting. Disable takes effect during authorization, before every provider hop and before returning results; enabling never widens or resurrects revoked/expired grants. Writes remain unavailable/default-off.

Single-process admission allows one parsed/validated stateless MCP POST execution per account across clients/gyms. It releases on response finish/close; tool work independently allows one operation/account. Unsupported GET/SSE and incomplete uploads never occupy the execution slot, so initialization is not deadlocked by a nested reservation. This is not a distributed lock; retain the documented single-instance deployment constraint. Existing limits remain60 requests/min/account,40/min/client/grant,1,000 requests/day/account; provider work remains6/min/account/gym,200/day/account,30/min/gym,60/min/fleet and six attempts/tool. No budget or provider flag was raised.

MCP tools and native API routes both call `normalized-reads`, which now caches normalized class details/bookings for5seconds and credits for15seconds. Keys bind account, gym, link identity, account-auth fingerprint and hashed gym session; cache hits and results recheck current context and MCP authorization. Expired session entries are not reused; a renewal owned by the read may return fresh data but is not cached under the prior session key. Completed values can be reused across app/MCP, but in-flight work is separated by admission lane. The private cache is bounded to256 entries/8MiB,256KiB per entry and32 flights, clones returned values and never serves stale/error fallback. Non-cacheable large responses still return normally.

The shared transport invalidates before/after non-credential mutation attempts for all callers, including uncertain failures, and holds mutation coherence through a bounded response body. Existing route write invalidation also covers mock adapters without HTTP. Reads overlapping writes reject with retryable503 instead of returning or caching a stale result. Timetable keeps its existing TTL/stamp semantics; generation-keyed flights prevent old pre-invalidation requests from repopulating or being joined by post-write requests. No provider policy, request budget, deployment flag or client UI changed.

## All-linked consent and shared mutation prerequisite (undeployed)

New OAuth transactions disclose all current/future linked gyms without a selector. An additive grant marker enables dynamic intersection with current links and admin policy; old grants and pending old transactions retain their snapshot semantics. A gym-less account may consent but gains no gym until it links one. Discovery is paginated, up to50 gyms/page. Existing scopes never widen silently.

The sole user-facing MCP preference is “Allow AI booking changes”, off by default in first-party AI connections. It requires local account sign-in, host-only interaction cookie, Origin/CSRF validation and an authenticated account fingerprint. Saving increments a durable preference revision; admin policy changes also advance revisions, including disable/re-enable. Explicit `bookings:write` OAuth consent and the independent default-off `MCP_WRITES_ENABLED` deployment flag do not replace action approval. No MCP write tool is executable yet.

Native book/cancel/spot-change routes now call `normalized-mutations`; future MCP actions must use this same app boundary. Trusted guarded callers may suppress auth retries, require a single owned cancellation without guests, and prohibit cancel/rebook edit fallback. The provider atomic-only option rejects missing swap endpoints, even when a gym advertises atomic swap; native fallback behavior is preserved. Durable approval/idempotency/reconciliation remain the next slice before any MCP write activation.

## Runnable scope

`MCP_ENABLED=false` is the default. `/mcp` and `/.well-known/oauth-protected-resource/mcp` return 404. Setting it true requires canonical HTTPS `MCP_RESOURCE_URL` ending in `/mcp`, canonical HTTPS `MCP_ISSUER`, and `MCP_JWKS_FILE` containing operator-owned public signing keys. Invalid configuration fails closed. Keys are loaded at startup; rotation currently requires a restart. There is no remote metadata/JWKS fetch, client-ID URL fetch, dynamic registration or token URL parameter.

SDK **1.32.2**, JOSE **6.2.13**, and Zod **4.6.7** are pinned. The installed SDK supports protocol **2025-11-25**: this implementation deliberately accepts only that revision, stateless Streamable HTTP, JSON responses, POST and OPTIONS. GET streams, sessions, resumption, JSON-RPC batches and extra tool arguments are rejected. The later revision discussed in the original research is not claimed compatible.

`MCP_PROVIDER_READS_ENABLED=false` additionally hides the four tools that may contact providers. With both flags explicitly enabled, the catalog is:

| Tool | Required scope | Limits |
|---|---|---|
| `list_connected_gyms` | `account:read` | Approved and currently linked gyms, maximum 10 |
| `search_classes` | `schedule:read` | One explicit gym, 1–14 inclusive days, 1–50 records/page, offset ≤1000 |
| `get_class_details` | `schedule:read` | One explicit gym/class, maximum 100 spots |
| `get_my_bookings` | `account:read` | One explicit gym, 1–50 records/page, offset ≤1000 |
| `get_credits` | `account:read` | One explicit gym, maximum 50 inventories, no cross-gym total |
| `get_automation` | `automation:read` | Local database only, explicit gym, 1–50 records/list/page |

Both PWA read routes and MCP reuse `server/normalized-reads.js`. Normal PWA request shapes and relogin behavior are preserved. MCP does not expose raw payloads, email/guest identities, passwords, account recovery, purchases, mutation or arbitrary proxy tools. External text is allowlisted, bounded and identified as untrusted data; instruction-like text is not presumed safe merely because it came from a gym. Output is capped at 32 KiB.

## Authorization contract and operator controls

The resource server uses JOSE to verify access tokens. An opt-in first-party authorization server now integrates maintained **@node-oauth/oauth2-server 5.3.1**; it owns authorization-code/PKCE/redirect validation and refresh rotation. The application supplies local account proof, explicit consent and durable hashed storage. No external subject/email is accepted as proof of a local account, and the gym-development login bypass is not used.

With `MCP_AUTH_SERVER_ENABLED=true`, the issuer must be the resource origin with a trailing slash. Discovery is `/.well-known/oauth-authorization-server`; browser sign-in and consent begin at `/oauth/authorize`, and token exchange is `/oauth/token`. Only authorization-code plus S256 and refresh grants are enabled. Exact configured callbacks, an explicit exact `resource`, client state (16–512 printable characters), and explicit read scopes are required. Both public and confidential preregistered clients are supported; confidential secrets are checked against operator-configured SHA-256 hashes. There is no dynamic registration, remote client metadata or password grant.

Browser interactions use ten-minute opaque Secure/HttpOnly/SameSite=Lax host-only cookies, separate CSRF values, exact first-party Origin checks, account password fingerprints, and one-use consent. Local sign-in has independent IP and hashed-account budgets (10 attempts/15 minutes). All requested scopes and gyms start unchecked. The resulting grant expires in 30 days; access JWTs expire in ten minutes. Authorization codes expire in 60 seconds and are atomically consumed before PKCE validation. Refresh tokens rotate, are stored only as hashes, and reuse revokes the entire grant including descendants and access JWTs. Concurrent refresh failure also revokes the family.

The authorization server issues RFC 9068 access JWTs with `typ=at+jwt`, RS256 or ES256, exact single `aud=MCP_RESOURCE_URL`, matching `iss`, `iat`, `exp` no more than 15 minutes after issue, `sub`, `client_id`, `jti`, `scope`, and `sa_grant_id`. PWA JWTs and gym tokens are rejected.

`server/mcp/store.js` exposes an **internal** consent/provisioning seam: register a known client, then create a grant binding the proven subject and issuer to an existing local account, registered client, approved read scopes, explicitly selected current gym links, expiry (maximum 30 days), and consent reference. There is no HTTP provisioning endpoint. A caller must not use an arbitrary external email/subject as proof of the local account or label an operator-created record as user consent.

Every operation checks the current grant, account, scopes and gym link again. Account password changes/recovery, deletion, client disablement, grant expiry/revocation and gym disable/unlink prevent use. Unlink then relink does not revive the previous gym approval because it is bound to the original link row. New gym links do not expand grants. In-flight results are discarded if authorization changes before completion. Revoking a grant cannot undo upstream work already submitted.

Local operator commands use the service's normal `DB_PATH`:

```bash
node server/mcp/manage.js list USER_ID
node server/mcp/manage.js revoke USER_ID GRANT_ID
node server/mcp/manage.js revoke-all USER_ID
```

These commands do not mint credentials. Settings → Account now exposes **AI connections** only when both MCP and the local authorization-server flags are enabled. `/oauth/connections` requires a fresh local account sign-in and shows approved scopes/gyms, expiry and last use, with revoke-one/all controls. This is a separate account page, not an application modal.

### Private configuration (no deployment performed)

Generate a new private ES256 key pair offline:

```bash
node server/mcp/create-keys.js /private/mcp
```

The directory should be private to the service user. The helper creates mode-0600 `signing.json` and `jwks.json` and refuses to replace existing files. Keep keys and client secrets out of git and logs. Supply an operator-owned JSON clients file:

```json
{
  "clients": [
    {
      "id": "invited-client",
      "name": "Invited AI client",
      "public": true,
      "redirectUris": ["https://client.example/EXACT_CALLBACK_FROM_CLIENT"]
    }
  ]
}
```

For a confidential client, set `public:false` and `secretHash` to the 64-character lowercase SHA-256 digest of a separately exchanged high-entropy client secret. Do not guess ChatGPT/Claude callbacks: copy exact values from the intended client's configuration and verify them during acceptance. Each client ID/name is persisted on startup; disabled IDs remain disabled. Configuration supports at most ten clients, five exact canonical HTTPS callbacks each. Client metadata is never fetched.

Set `MCP_ENABLED=true`, `MCP_AUTH_SERVER_ENABLED=true`, `MCP_RESOURCE_URL=https://YOUR_HOST/mcp`, `MCP_ISSUER=https://YOUR_HOST/`, `MCP_JWKS_FILE=/private/mcp/jwks.json`, `MCP_SIGNING_KEY_FILE=/private/mcp/signing.json` and `MCP_CLIENTS_FILE=/private/mcp/clients.json`. The signing public key must match the pinned resource JWKS. Retain `MCP_PROVIDER_READS_ENABLED=false` until intended-deployment acceptance is complete. No configuration here enables a public listener or deployment by itself.

Browser pages use the single existing stylesheet, no script, no framing and same-origin referrers. Consent alone permits its immutable configured callback origin in CSP `form-action` because Chrome applies that directive across OAuth redirects. Both the same-origin POST and cross-origin redirect were verified in the user's real Chrome. TLS certificate acceptance for the isolated self-signed test fixture was scoped to the owned test tab; production requires valid HTTPS.

## Admission and its limits

SQLite transactions persist fixed-window budgets across application restarts. Values are conservative operational choices, not published provider quotas. Request limits apply in every environment: 120/minute/source IP before verification, 60/minute/account, 40/minute/account/client and account/grant, 1000/day/account. Tool concurrency is 2/account and 1/account/gym, with a 12-second operation deadline and abort signal for network calls. Body limit is 16 KiB.

Actual MCP-caused provider HTTP attempts through the shared transport hook cost 6/minute/account/gym, 200/day/account, 30/minute/gym and 60/minute/fleet; each operation permits at most six attempts. Cache hits incur no provider attempt. All dimensions are charged atomically or rejected. Shared scheduler/poller cooldown is consulted; MCP-observed 429s populate it and honor `Retry-After`. Extra grants and clients do not reset account budgets. Failed budget storage refuses admission.

**Updated:** common transport admission, credential-hop accounting, scheduler/PWA reservations and cache/deadline isolation are implemented in the candidate described below. Keep provider reads disabled for any public pilot until real deployment/client acceptance; independent source review is recorded below. Only one instance is supported; budgets are durable, but concurrency, cache and cooldown are process-local.

Structured audit records include local account/client/grant, tool, gym, result code and duration, without raw provider bodies or credentials. Consent/revoke/refresh-replay events are also redacted audit records. Interactions and codes are deleted at expiry; consumed refresh hashes remain until expiry to detect replay. Expired/revoked grants are deleted after 30 days. Cleanup runs per OAuth request and every 15 minutes while the local authorization server is active. Bounded container log rotation and aggregate metrics/alert rules now ship in repository configuration; live scrape, dashboard and alert-receiver acceptance remain deployment gates.

## Verification and release gates

Independent source review was completed on 24 October; [scope, two reproduced fixes and bounded conclusions](MCP-SECURITY-REVIEW.md). This closes the local source-review gate only. Actual client/proxy/device/monitoring acceptance below remains required.

Run `npm test` under the repository-required Node 20 and `npm run build:client`. The new standalone server suite exercises the real SDK client and HTTP transport with both provider mocks, strict auth/permission boundaries, bounded outputs, upstream-attempt admission, cooldown, revocation and concurrency. No live gym traffic is used.

Before an invited read-only release:

1. Retain the completed independent review evidence for the maintained OAuth integration and its local identity/consent/storage policy. The new HTTP suite and real Chrome flows now prove the implementation, including cross-origin callbacks.
2. Complete named-client and device acceptance beyond the local fixture. Chrome 155 browser evidence covers local SA sign-in, unchecked scope/gym consent, SDK exchange/read, connection inspection and revoke, Settings link flag gating, and a 390px mobile layout. Actual ChatGPT local reads, refresh denial after revocation and latest restoration are verified. User-reported physical Safari checks passed Home stability/navigation and management sign-in/keyboard layout; phone consent-checkbox/layout/Back subsequently passed without Allow/Deny or a new grant. Completed phone approval/revocation and installed-PWA acceptance are not claimed.
3. Retain the completed independent review evidence for the common admission, renewal, scheduler/PWA reservation and cache/deadline contracts below; enable provider reads only after intended-proxy and monitoring acceptance.
4. The user has deferred **Claude** acceptance; it remains unverified and must not be advertised as compatible. The selected initial pilot target is **ChatGPT**: actual consent, local reads and causal server refresh denial after revocation passed. Latest reconnect account association is confirmed and the healthy connection is preserved. Finish intended-proxy request bounds/deadlines and other acceptance independently; SDK interoperability alone is insufficient.
5. Retain clean dependency audits and completed independent source review, and prove rollback/kill-switch acceptance. Only isolated staging has been deployed; production configuration is unchanged.

Booking writes and automation creation remain later delivery phases with first-party action approval, durable idempotency, reconciliation and separate acceptance.

## Common admission candidate — 24 October

`server/provider-admission.js` now applies a single-instance boundary to every native provider HTTP attempt, including cart/mutation requests, public reads, pagination, background work and each login/refresh redirect/token hop. Server-assigned actor context distinguishes scheduler (including its GET preflight), interactive authenticated PWA work, and optional background/MCP work. Unattributed work shares a restrictive background account bucket; it does not acquire a new budget per request or credential. No lane comes from a client header, tool argument or HTTP verb.

Common limits activate with `PROVIDER_ADMISSION_ENABLED=true`, or automatically when **both** `MCP_ENABLED=true` and `MCP_PROVIDER_READS_ENABLED=true`. Default-off PWA operation retains its former admission behavior. MCP contexts always participate. Policy values are conservative fixed pilot defaults; changing them requires measured review and tests, rather than an uncontrolled provider-quota probe.

| Scope | Total per minute / concurrency | Non-scheduler ceiling | Optional background + MCP ceiling |
|---|---:|---:|---:|
| Fleet | 120 / 12 | 90 / 8 | 60 / 4 |
| Gym | 90 / 8 | 60 / 6 | 30 / 3 |
| Account | 60 / 6 | 30 / 5 | 12 / 2 |

Daily account/fleet totals are 1,000/10,000; non-scheduler ceilings are 700/7,000 and optional ceilings 400/4,000, preserving daily reservations too. Existing stricter MCP account/gym/operation budgets also apply. Fixed-window counters persist atomically in SQLite across restart, fail closed if unavailable, and permit a boundary burst. There is no shared admission queue or automatic mutation retry. A single MCP tool may hold at most six internal pending transport hops, executed serially to keep existing adapter pagination from exceeding its own optional concurrency cap; every hop rechecks authorization/deadline/budgets before transport. Capacity/cooldown refusal supplies retry guidance. Upstream `Retry-After` is shared across every lane; provider cooldown deliberately pauses scheduled traffic too.

Optional MarianaTek pagination uses at most two workers; a cold four-way first-party metadata fetch fits its essential account reservation.

Every admitted network call gets a ten-second abort deadline and a four-MiB streamed body cap; the concurrency reservation lasts through body completion, failure or cancellation. MCP additionally retains its twelve-second operation deadline and receives SDK request cancellation. Optional MCP/background in-flight owners cannot make scheduler/PWA work wait on their cancellation: schedule, profile, class-list and freshness single-flight keys separate actor lanes, while successfully completed safe cache values stay shared. MCP does not start stale-while-revalidate work that would outlive its own request; bounded stale data may be served, then refreshed synchronously once beyond the stale window. Credential renewal is now allowed only through accounted hops and the existing tool attempt ceiling, which may refuse a long multi-step login; the user can re-link through the PWA.

Aggregate metrics: `provider_admission_total{lane,result}`, `mcp_tools_total{tool,result}`, `mcp_tool_duration_milliseconds_total{tool}`, `mcp_ingress_rejections_total{result}`, and `schedule_cache_total{result}`. Existing provider attempt totals count actual calls, not capacity refusals. No account/grant/token is a metric label. Client cost/latency observability additionally uses mcp_client_tools_total, mcp_client_tool_duration_milliseconds_total, mcp_client_provider_calls_total, mcp_client_cache_total and mcp_client_admission_total. Only server-known preregistered client IDs can become labels, capped at ten distinct clients per process plus a fixed other bucket; tool and gym dimensions are also bounded. These distinguish cache hits, actual upstream attempts, refusals, tool outcomes and latency without labeling account data. Alert rules are supplied in [`../Operations/mcp-alerts.yml`](../Operations/mcp-alerts.yml), but an operator must load them into the real monitoring stack and configure a receiver. Both Compose definitions rotate container JSON logs at ten MiB with three files (about thirty MiB/container); these are repository configurations, not applied deployments.

Root, server and client dependency audits are clean after sharp 0.35.5/node-cron 4.6.0, Vite 6.4.5/Vitest 4.1.12 and compatible transitive security updates. Independent source review is complete; before public enablement still complete real deployment acceptance. The read-only command `node scripts/mcp-proxy-smoke.js https://YOUR_HOST/mcp` checks actual HTTPS discovery, challenge preservation and hostile-Origin rejection without gym traffic or credentials. It has only been syntax-checked here; no staging endpoint was created. Preserve canonical Host, reject spoofed forwarding headers and configure trusted client-IP handling at the actual proxy before testing it; the application currently uses socket IP rather than trusting arbitrary `X-Forwarded-For`.

**Current external release gates:** isolated HTTPS staging and ChatGPT registration exist; actual ChatGPT local reads and server refresh denial after revocation passed. The latest reconnect produced an active two-scope grant, but both exposed client handles currently fail locally without stage traffic, so restoration remains unconfirmed. Claude acceptance is deferred by the user and remains unverified. Before an invited read-only release, finish authenticated proxy bounds/deadlines, real iOS/device acceptance, private dashboard/human alert-delivery acceptance as applicable, restart-surviving budgets, and scoped kill-switch/rollback exercises. Provider-backed tools require separately authorized bounded live acceptance and remain disabled. Retain independent review evidence and agree pilot population/limits. Production has not been deployed.
