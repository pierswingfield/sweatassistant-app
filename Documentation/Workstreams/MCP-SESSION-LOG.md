# MCP implementation session log

## 2026-10-24 — scope and isolated setup

- User authorization: build `PLAN-mcp-server.md` toward a release candidate, using branch `mcp_tooling`, one development subagent at a time. Existing worktrees and `master` must remain unchanged.
- Created `/home/ubuntu/AI Projects/psycle chrome/App-mcp_tooling` on new branch `mcp_tooling` from `master` commit `02c4f646de394b881d71b5ee02601b2dcc011b44`. No existing branch/worktree was changed or pruned.
- The requested plan and its linked security research are untracked inputs in the original workspace, absent from `master`. Copied those two documents into this isolated worktree; no other original changes were imported.
- Read the agent protocol and testing instructions. Used Gemini Flash once to locate constraints across documentation, then checked specific source references. Rejected its unsupported claim that client files must remain unmodified: no such general rule exists.

### Verified starting evidence

- `server/package.json` has no MCP SDK or OAuth authorization-server dependency.
- `server/routes-normalized.js:279` owns linked-gym reads; timetable at line 399, event details at 459, bookings at 717, and credits at 784. Timetable uses the shared schedule cache at line 412. Reads are embedded in Express handlers, requiring a shared application boundary before MCP reuse.
- `server/auth.js:182` onwards verifies existing application JWTs; `authenticateTokenSSE` also accepts query-string tokens. These must not become the MCP credential verifier.
- Immediate normalized write route declarations (`/book`, `/cancel`, `/swap`) do not attach the separate booking mutation limiter. Read-only implementation avoids exposing them; write stages remain deferred.
- No implementation code was changed in this scoping step. No automated suite was run yet.

### Browser and acceptance limitations

`curl --max-time 3 http://127.0.0.1:9222/json/version` could not connect. No Claude-for-Chrome or testing-Chrome tool is available in this agent's tool catalog. The prescribed alternative exists in historical project records but is unavailable to this runtime. Checked documentation for an existing Chrome tunnel; no usable configured tunnel was identified. No fresh browser was launched.

**BLOCKED: no real-browser access** for new consent/settings pages and their required before/after verification. This blocks a complete user-facing release candidate. Independent server-only preparation may proceed under the protocol's request/failing-test evidence rule; this does not waive browser or real-client acceptance.

### Proposed implementation sequence and gates

1. Server-only compatibility/design spike, disabled by default: verify current SDK/protocol against official sources, evaluate maintained OAuth authorization-server integration with existing local identity, document threat model and bounded catalog, and select registered pilot clients. Gate: reproducible MCP client transport tests and no public endpoint or user-visible edits until browser access is restored.
2. Shared read services and persisted least-privilege grants, token domain separation, current gym-link enforcement, immediate revocation, strict input/output schemas. Gate: failing-before/passing-after isolated security tests, bounded normalized outputs, no direct provider shortcut or fabricated Express request.
3. Resource admission: account/client/grant ingress limits, provider-attempt accounting, per-account/gym concurrency, daily ceilings, common cooldown policy, reserved scheduler/PWA capacity, single-instance durable budget policy. Gate: mock load tests prove hard upstream bounds and scheduled-job availability; force limiters in tests.
4. OAuth consent and Account AI-connections controls after real Chrome is available. Gate: discovery, PKCE, exact redirects, refresh rotation/reuse defense, consent/revoke/reconnect and isolation tests plus browser evidence and named AI-client interoperability through the intended proxy.
5. Read-only invited release candidate: `list_connected_gyms`, bounded `search_classes`, `get_class_details`, `get_my_bookings`, `get_credits`, `get_automation`. Gate: full `npm test`, client build if affected, real Chrome/iOS acceptance, actual selected AI-client tests, kill switch, rollback and operator documentation. Writes and automation creation are later separate releases.

### Decisions and next work

Provisional safe defaults: invited registered clients; read-only scopes; explicit gyms; no automatic new-gym grant expansion; no dynamic metadata fetch; no payments/writes; disabled by default; single application instance; no deployment this step. Named target AI client(s), auth-server ownership, production budgets and retention remain implementation decisions to resolve from verified compatibility facts. Final client acceptance requires user access to those clients.

Recommended next task: a bounded server-only compatibility/auth-library spike, returning an exact dependency/protocol decision and executable test evidence; do not claim release readiness or implement browser-dependent UI while browser access is unavailable.

## Server development — verified basis and design decision

Before implementation, `require('./server/mcp/router')` failed because the MCP router did not exist. The installed SDK's own constants identify latest supported protocol `2025-11-25`, despite the proposed research targeting a later revision. Pin SDK 1.32.2 and test its actual stateless Streamable HTTP implementation. SDK and JOSE upstream repositories and the official 2025-11-25 authorization specification were checked. Gemini Flash supplied a constraint checklist; protocol-version suggestions were not accepted without SDK evidence.

Authorization decision: implement an OAuth resource server using maintained JOSE, externally issued RFC 9068 access JWTs, operator-pinned local JWKS, and locally bound explicit account/client/subject/grant/gym records. No authorization server or hand-rolled code/token endpoints. A verified first-party consent interaction and actual authorization-server integration remain mandatory before release; internal/test grant creation is not human consent. No UI edits while browser access is unavailable.

### Implemented server milestone

- Pinned official MCP SDK 1.32.2 (actual protocol 2025-11-25), JOSE 6.2.13 and Zod 4.6.7. Stateless Streamable HTTP/JSON with host/origin, method/protocol, batch, request-size and schema boundaries. Endpoint and protected-resource metadata remain disabled by default; a second flag disables provider-backed tools independently.
- Added durable preregistered clients, explicit account/issuer/subject/client/scopes/gym-link grants, immediate/in-flight revocation, password-change/account-deletion invalidation and unlink/relink protection. Internal provisioning seam and local operator list/revoke commands exist; actual first-party OAuth consent and authorization-server integration do not.
- Added shared normalized reads reused by PWA routes and the six read-only MCP tools. Responses use bounded allowlisted fields and omit raw payloads, private preferences and guest/account emails.
- Added transactional fixed-window request and actual-provider-attempt budgets, single-instance concurrency/deadline handling and shared provider cooldown. All adapter public/authenticated read fetch seams are intercepted in tests. MCP-triggered credential renewal fails closed until every login hop is accounted for. Universal PWA/background admission and reserved capacity remain incomplete; provider reads must remain disabled for public deployment.
- New security/transport suite passes 72 checks with both existing gym-platform mocks and the real SDK client, without live traffic. The initial Node 22 run passed all 94 server suites; client build passed. Node 20 authoritative checks and mutation validation are being completed before commit.

### User steering: real browser restored and acceptance clients selected

The user supplied `http://100.108.68.20:9222` and selected **both ChatGPT and Claude**. A read-only `/json/version` check succeeded and reported Chrome 155.0.8059.86. No tab was opened or navigated. The earlier access blocker is resolved; first-party consent/settings still need actual before/after browser verification and AI-client interoperability. No UI change is included in this server handoff.

Dependency audit currently reports existing shared dependency findings (including the Express 4 ingress parser and IP-address library also shared with the SDK's rate-limiter dependency), plus unrelated image/cron/dev dependencies. Gemini Flash's claim that these were wholly unrelated to MCP was rejected after checking the actual dependency chains. No broad dependency upgrade was applied; applicable audit remediation is an explicit pre-release gate.

### Final development validation and handoff

- **Authoritative full run:** `VITEST_MAX_WORKERS=2 npx -p node@20 -c 'npm test'`, Node **20.20.2**, completed successfully: **94/94 server suites; 94/94 client files; 711/711 client tests**. Workers were bounded through Vitest's supported environment setting without repository test-config changes.
- The earlier parallel Node 20 server/client run had one timing-sensitive failure in the existing read-rate-limit suite. Its sequential request loop crossed the fixed one-minute budget window under load. The isolated rerun passed (general request 301, refresh request 31), then the complete sequential authoritative run passed. The existing suite was not edited to suppress the failure.
- New MCP suite: **72 security/transport checks passed** with the actual SDK and both platform mocks. Mutation checks deliberately bypassed gym permission and permitted a seventh upstream attempt; both were caught. Restoring the implementation returned the suite to green.
- `npm run build:client` passed; `git diff --check` passed. Native SQLite was rebuilt for the required Node 20 runtime in this isolated worktree. Generated tracked mock state was restored after testing.
- No server was deployed, no branch pushed, no live gym request made, and no user's Chrome tab opened or navigated. Only the new `mcp_tooling` worktree was edited.

**Exact remaining release requirements:** choose/integrate a maintained authorization server using proven local SA identity; implement code/PKCE, exact redirects, state, refresh rotation/reuse and first-party consent-to-grant binding; implement browser-verified Account AI connections/explicit gyms/revoke controls; finish common upstream/login admission, scheduler/PWA reserved capacity and cache/deadline fairness; complete metrics/alerts/retention and applicable dependency audit remediation; prove OAuth/read/revoke/reconnect in **both ChatGPT and Claude** and through the intended HTTPS proxy; independent security review. Browser connectivity is now available, so it is no longer a reason to defer the next implementation stage.

Recommended next task: use one next development agent to implement a maintained authorization-server integration and actual SA login/consent, preserving the local account as the source of identity and using the existing internal grant seam. An arbitrary external subject/email or operator-created mapping is not account proof. Review the common budget boundary before enabling provider reads; normal PWA/background traffic currently keeps its prior admission behavior.
