# MCP server foundation

**2026-10-24: implemented server foundation, not a user-facing release candidate.** See [delivery plan](PLAN-mcp-server.md) and [session evidence](MCP-SESSION-LOG.md). No deployment or live gym request was made.

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

This is an OAuth **resource server**, using JOSE to verify access tokens. It is not an OAuth authorization server and does not replace the local account login. Production authorization-server selection/integration is incomplete. The deterministic SDK integration fixture in `server/test-mcp.js` is the runnable local integration: it creates ephemeral signing keys and explicitly bound mock grants; it never represents human consent.

The eventual maintained authorization server must use authorization code + S256 PKCE, exact preregistered redirects, anti-CSRF state, refresh rotation/reuse defense, and a verified first-party local-account login/consent interaction. It must issue RFC 9068 access JWTs with `typ=at+jwt`, RS256 or ES256, exact single `aud=MCP_RESOURCE_URL`, matching `iss`, `iat`, `exp` no more than 15 minutes after issue, `sub`, `client_id`, `jti`, `scope`, and `sa_grant_id`. PWA JWTs and gym tokens are rejected.

`server/mcp/store.js` exposes an **internal** consent/provisioning seam: register a known client, then create a grant binding the proven subject and issuer to an existing local account, registered client, approved read scopes, explicitly selected current gym links, expiry (maximum 30 days), and consent reference. There is no HTTP provisioning endpoint. A caller must not use an arbitrary external email/subject as proof of the local account or label an operator-created record as user consent.

Every operation checks the current grant, account, scopes and gym link again. Account password changes/recovery, deletion, client disablement, grant expiry/revocation and gym disable/unlink prevent use. Unlink then relink does not revive the previous gym approval because it is bound to the original link row. New gym links do not expand grants. In-flight results are discarded if authorization changes before completion. Revoking a grant cannot undo upstream work already submitted.

Local operator commands use the service's normal `DB_PATH`:

```bash
node server/mcp/manage.js list USER_ID
node server/mcp/manage.js revoke USER_ID GRANT_ID
node server/mcp/manage.js revoke-all USER_ID
```

These commands do not mint credentials. User-facing connection/revocation controls remain unimplemented.

## Admission and its limits

SQLite transactions persist fixed-window budgets across application restarts. Values are conservative operational choices, not published provider quotas. Request limits apply in every environment: 120/minute/source IP before verification, 60/minute/account, 40/minute/account/client and account/grant, 1000/day/account. Tool concurrency is 2/account and 1/account/gym, with a 12-second operation deadline and abort signal for network calls. Body limit is 16 KiB.

Actual MCP-caused provider HTTP attempts through the shared transport hook cost 6/minute/account/gym, 200/day/account, 30/minute/gym and 60/minute/fleet; each operation permits at most six attempts. Cache hits incur no provider attempt. All dimensions are charged atomically or rejected. Shared scheduler/poller cooldown is consulted; MCP-observed 429s populate it and honor `Retry-After`. Extra grants and clients do not reset account budgets. Failed budget storage refuses admission.

**Incomplete:** PWA/background/login traffic is not universally admitted by a common global budget. MCP-triggered credential renewal is therefore refused: reconnect the gym through the app. This prevents hidden login fan-out but is a deliberate limitation against the final plan. Public and authenticated adapter read transports participate; existing non-MCP traffic keeps its prior behavior. The provider-read flag must stay false for public deployment until common admission, capacity reservation/fairness, all login hops, cache/SWR interactions, cancellation and deadlines have been reviewed. Budget state is durable; concurrency/cache/backoff are process-local, so only one instance is supported. Fixed windows can allow a boundary burst; no sliding-window guarantee is made.

Structured audit records include local account/client/grant, tool, gym, result code and duration, without raw provider bodies or credentials. Full upstream-cost/cache-hit/reject dashboards, retention policy and abuse alerts remain release gates.

## Verification and release gates

Run `npm test` under the repository-required Node 20 and `npm run build:client`. The new standalone server suite exercises the real SDK client and HTTP transport with both provider mocks, strict auth/permission boundaries, bounded outputs, upstream-attempt admission, cooldown, revocation and concurrency. No live gym traffic is used.

Before an invited read-only release:

1. Implement and verify the maintained authorization server's local SA identity bridge, code/PKCE/redirect/state and refresh flow. Wire real consent to the internal grant seam; no manual subject/email mapping as proof of identity.
2. Use the actual user's Chrome CDP endpoint `http://100.108.68.20:9222`; verify consent/settings before and after changes. Implement AI connections, explicit gym selection, expiry/last-use and revoke-one/all. Chrome 155 is now reachable (read-only `/json/version` verified); consent/settings browser acceptance has not been performed.
3. Complete common provider admission, renewal accounting, scheduler/PWA reserved capacity, restart/failure/load tests, metrics/alerts and retention. Review shared-cache cancellation/SWR interaction under MCP deadlines before enabling provider reads.
4. Target both **ChatGPT and Claude**, as selected by the user, and prove OAuth consent, reads, revoke/reconnect, discovery, HTTPS proxy Host/Origin handling and request deadlines through the intended deployment. SDK interoperability alone is insufficient.
5. Resolve applicable dependency audit findings, independent security review and rollback/kill-switch acceptance. No deploy/production configuration has been changed.

Booking writes and automation creation remain later delivery phases with first-party action approval, durable idempotency, reconciliation and separate acceptance.
