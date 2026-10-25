# MCP read-only release candidate 1

Version: **`mcp-readonly-rc.1`**, 25 October 2026. Local annotated Git tag on `mcp_tooling`; resolve the tag for the exact packaging commit. This is a bounded staging release candidate for review, **not invitation or production readiness**. No push, registry publication, production deployment or merge is included.

## Source and artifacts

The final reviewed source is `b0ecfaf`, reviewed sequentially for Standards and Spec/security from merge-base `02c4f64`; no actionable finding was reported. Review/test record reconciliation is `f5f3b78d2912f374230119ee94f30265a6bd1a29`. Packaging changes only documentation and ignores the local artifact directory. Runtime source in `server/`, `client/`, `Dockerfile` and root dependency manifests is unchanged from deployed reviewed app commit `a501b01b37cfaf3e70d57ca43c4de2a72d402286`.

Local deliverables are `artifacts/mcp-readonly-rc.1/source.tar.gz`, its `source.tar.gz.sha256` sidecar and `release.json`, containing the resolved tag/commit, archive SHA-256 and immutable image identities. The source archive is made only from tracked files at the tag, not the working tree. It excludes ignored runtime secrets, data, dependencies and generated builds; example configuration remains included. The artifact directory is ignored. Verify it with `sha256sum -c source.tar.gz.sha256` from that directory.

The existing, source-equivalent reviewed ARM64 image is reused without a new build or deployment. Local alias `sweatassistant-mcp-rc:readonly-rc.1` points to app image/index ID `sha256:87ece085974871ac6b69ed2aa5426d8b384c3f001bb340c765d7cec9038eca8c`, ARM64 manifest `sha256:31cd7c26663529a52863dcca2a6437dba8df683471d8d08f2e85146fa1985e81`, config `sha256:dd931d632d697b121854d7b9b6bb308c4df9d79f6168ae3097bd13e683191454`. It has no OCI revision label; source correspondence is recorded here and verified by the clean runtime-source diff. These are local Docker identities, not published registry digests. No redundant image export is bundled. The local Docker engine is Oracle's shared engine.

## Validation

Node **20.20.2** full `npm test`: **101/101 server suites**, **94/94 client files and 711 tests** passed. Production `npm run build:client` passed under the same Node version; existing Vite mixed-import/large-chunk warnings remain. No production code changed after these checks.

Actual ChatGPT executed `list_connected_gyms` and `get_automation` with only the explicitly approved JAB/account-read/automation-read grant. Supported per-grant revocation then caused a server-rejected refresh and prevented another tool execution. The latest reconnect has a valid active grant but the exposed client handles still report local reauthentication without reaching staging; **restoration is unconfirmed**. No further password interaction is requested for this candidate.

The deployed HTTPS proxy passed independent supported-flow OAuth/S256 exchange, authenticated normal ping, 17,053-byte body rejection (413), subsequent ping success and spoofed forwarding headers remaining in the same application IP-budget bucket. This retains conservative shared proxy/socket accounting; it does not prove independent trusted client-IP attribution. Offline exact-image gateway fixtures prove stalled-upstream deadline/disconnect abort and slot release; public-proxy stalled-provider behavior was not deliberately induced.

Private monitoring scrape/dashboard API and internal synthetic alert firing/resolution passed. Staging restart retained durable daily-budget totals; MCP kill-switch/restore and application-image rollback/restore passed without changing account/gym/client/grant aggregate counts. Full DNS/tunnel/Access unpublish rollback was documented but not exercised. See [staging evidence](MCP-STAGING.md), [review](../Workstreams/MCP-SECURITY-REVIEW.md) and [session evidence](../Workstreams/MCP-SESSION-LOG.md).

## Runtime scope and limits

Staging stays on `sweatassistant-mcp-stage:a501b01-metrics-review`; gateway stays on `sweatassistant-mcp-stage:8082bb3-gateway-review` (image/index ID `sha256:f857d6999767409bafca832a857cdf59c514b4b439eeff9cd9fe3ca7b5dc37ff`). No restart is required for packaging. `MCP_ENABLED=true`, `MCP_AUTH_SERVER_ENABLED=true`, **`MCP_PROVIDER_READS_ENABLED=false`**, **`MCP_STAGE_JAB_PROFILE_ONLY=true`**. The app has only its internal network and no host port. Background provider services remain suppressed. The existing isolated staging URL is `https://sweat-mcp-stage.wingfield.tech/mcp`; production/dev are unchanged.

Six read-only tools are implemented behind scope and feature checks. Only the two local tools are currently available; class search/detail, bookings and credits provider reads remain disabled and have not received live acceptance. No booking/payment writes or automation creation are exposed. The [future bounded provider-read proposal](MCP-PROVIDER-READ-ACCEPTANCE.md) requires implementation/review and separate authorization before enabling those reads.

Claude acceptance was explicitly deferred and compatibility remains unverified. Actual iOS Safari/installed-PWA acceptance remains a **pre-invitation** requirement; desktop mobile viewport evidence is not iOS evidence. Latest ChatGPT restoration, provider-read authorization/acceptance, remaining intended-proxy deadlines, human alert delivery and agreed pilot population/limits must be resolved as applicable before inviting users. This versioned candidate does not waive those gates.

## Test-state cleanup

At 2026-10-25 00:10:22 UTC, after the original admin-login window reset, one normal operator login and supported admin DELETE removed the sole recorded gym-less synthetic refinement account. Preconditions confirmed it had no gym link or OAuth grant. Read-only before/after verification found zero owned accounts remaining and unchanged other-account, gym-link, grant, active-grant and client counts. The private cleanup pointer was removed. No limiter bypass, direct database deletion, user password reset or user-grant revocation was used.

## Follow-up acceptance evidence — 25 October 2026

The later real-Chrome check resolved the account-selection problem: two obsolete client entries requiring authentication were disconnected individually, preserving the healthy third entry and the sole active server grant. Fresh ChatGPT calls to both local tools succeeded with matching server counters. Latest restoration is therefore now confirmed; the original taggedRC1 archive retains its historical unconfirmed note. A separate bounded provider-read source candidate is pending independent review; staging remains on RC1's images with provider reads off. This follow-up does not replace or mutate the RC1 tag/archive.
