# MCP standing-read release candidate 3

Version **`mcp-rc.3`**,26 October2026, annotated local Git tag on isolated `mcp_tooling`. This is a concrete reviewed staging read candidate. It does not authorize production deployment, external invitations, writes or automation creation. No push, merge, PR or registry publication is included. Existing RC1/RC2 tags and artifacts remain immutable.

## Provenance and artifacts

Reviewed production app/broker source: **`5bfbfbbea8d69007e5c4b34967437a95f979ee24`**. The tag resolves the subsequent documentation/packaging commit; production source is unchanged between those commits. The legacy native login/profile gateway remains separately reviewed source `49d1fb752d53797f48c9d5081fac353e71360355`.

Local deliverables: `artifacts/mcp-rc.3/source.tar.gz`, `source.tar.gz.sha256`, `release.json`. The source archive is generated only from Git-tracked files at the final annotated tag, with prefix `mcp-rc.3/`. It includes the application/API/cache/admin-policy and guarded tool implementation, sanitized fixtures and example configuration. It excludes runtime env/keys/data/databases, dependency directories, generated builds and artifact recursion. `release.json` records the resolved packaging commit, distinct reviewed image-source commit, checksum, image identities, evidence and limitations. Verify with `sha256sum -c source.tar.gz.sha256` inside that directory. No image export is needed.

| Component | Local image tag | Image/index |
|---|---|---|
| App + standing read broker | `sweatassistant-mcp-stage:5bfbfbb-pagination-review` | `sha256:082058266116cd93a22a5714d13c77085a01ce11b93522138342845b1826fb38` |
| Legacy native login/profile gateway | `sweatassistant-mcp-stage:49d1fb7-body-reader-review` | `sha256:8db0e6c0bd41f43b8f0045a791707fa2b0709e805af9b852621eea3f40fa1435` |

App/broker ARM64 manifest: `sha256:880a9bb644cf9f5bc50d05b4e0b2605321b8877e0dc903e03b4d0d5b6f9f0a8a`; config: `sha256:08a6b4c33b9006a56ebb7b9811c4a9b43d6d317c086bb7b06e2bdb1f308cdfb2`. These are immutable local Oracle-engine identities, not published registry digests.

## Acceptance

See [RC3 acceptance evidence](MCP-RC3-ACCEPTANCE.md) and [session record](../Workstreams/MCP-SESSION-LOG.md). Reviewed image packaging/module hash, actual network-none production health, current production client build and zero-vulnerability installs passed. Historical full Node20.20.2 verification passed112 server suites and95 client files/712 tests; subsequent focused action42/broker34/MCP85/admission28 checks and final parser/cache/action regressions passed. No repeated full suite is claimed for the final narrow parser fix.

Actual ChatGPT, using the existing grant after metadata refresh, returned complete empty JAB upcoming bookings:0, complete=true, status=complete, nextOffset=null. Existing local gym/automation reads succeeded. Credits explicitly unmetered locally. No new consent/grant or provider write occurred. Stage retains1 user/1 link/9 historical grants/1 active; durable provider attempts3 total, broker mutations0. Prior same-image persistence, monitoring, kill-switch/rollback, public proxy and physical Safari evidence remain distinguished from this final parser/client acceptance.

## Runtime scope and limits

Endpoint: `https://sweat-mcp-stage.wingfield.tech/mcp`. Standing/provider reads and origin-abuse protection are enabled. App and broker write gates are **off**; profile-only mode continues suppressing background provider jobs. No short read-window lease remains. The app has only private networking/no host port. Broker mounts only its independent receipt key and replay ledger, not application DB/OAuth/encryption keys. Native API/root/metrics remain Access protected; no production/dev or Cloudflare zone change.

Read eligibility defaults across linked gyms according to reviewed account/gym admin switches and OAuth scopes. Existing OAuth scopes were not broadened. Six read tools are implemented; the existing account/automation grant exposes its permitted subset. Five guarded booking-action tools are built and mock-tested but remain disabled and hidden by write gates; user write preference defaults off. Automation creation is a separate later delivery.

Operational caps: **one MCP execution/account**, six actual provider attempts/tool,12 attempts/minute/account/gym,200/day/account,30/minute/gym and60/minute/fleet; native/scheduler priority reservations and shared cooldown/admission remain. Fresh normalized responses are reused by MCP and the native API; no agent-controlled force refresh. These are provisional operating caps, not contractual provider quotas.

Known boundaries: live proof covers empty JAB upcoming completeness only. Nonempty/CodexFit completeness, metered MarianaTek class cost/inventory and live booking/edit/cancel behavior remain unverified/fail-closed. No live write, payment or automation creation is authorized. Claude is deferred/unverified; retain prior selected physical Safari evidence without claiming full installed-PWA approval/revoke acceptance. Human alert delivery and full DNS/tunnel/Access unpublication rollback remain unproved. Cloudflare Free/current token cannot provide the requested hostname limiter (Rulesets Read10000); origin abuse protection is on, geographic/datacenter/browser challenges off pending verified client-egress policy. Wider invitations/production rollout need explicit scope and operational decisions.
