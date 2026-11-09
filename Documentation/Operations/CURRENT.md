# Current Dibs operations

As of 2026-11-09. This is the entry point for current deployment facts; dated audits and launch receipts describe their own inspection time.

| Surface | Canonical origin | Existing Oracle container |
|---|---|---|
| Marketing | https://dibs.fit | `dibs-landing` |
| Production | https://app.dibs.fit | `sweatassistant` |
| Dev | https://dev.dibs.fit | `sweatassistant-dev` |
| Experiment | https://experiment.dibs.fit | `sweatassistant-experiment` |

The current source is `master` in `App` (`4593db3`, pushed to `origin/master`), which merges `teams` and `feat/optional-gym-login-policy`. Completed worktrees (`App-CSSv2`, `App-homerun-barrys`, `App-security`, `App-teams`) were pruned on 2026-11-09, leaving `App-mcp_tooling` in place. Production (`sweatassistant`) and Dev (`sweatassistant-dev`) both run merged `master` `4593db3` (including Teams, private-history personal statistics without the empty story paragraph, optional gym-login storage & policy acceptance, reconnect design sweep, and Home copy/class-name polish). All five configured gyms are enabled, including Homerun and Barry’s. Landing remains on UI/copy release `c98ef9a`; see the [polish receipt](../QA/browser-runs/onboarding-share-polish-2026-11-07/README.md). Experiment runs the 2026-11-09 pre-merge snapshot (`sha256:24fdf4be939a`); deployment and browser evidence are in the [experiment receipt](../QA/browser-runs/gym-login-policy-experiment-2026-11-09/README.md) and [Home copy receipt](../QA/browser-runs/home-copy-class-names-2026-11-09/README.md). The domain migration receipt remains the baseline for its hostname and Access configuration. Later documentation-only changes do not change deployed application code. Do not infer current remote health from this document: verify it when operating on a host.

`deploy.sh` defaults to dev; `--experiment` selects experiment and `--prod` selects production with typed confirmation. `deploy-landing.sh` selects the landing site. Scripts ship the working tree, so inspect its exact diff and target first. Load the `selfhost-deploy` skill before host work; keep its service registry current with infrastructure changes. All existing hosts are ARM64; use `docker compose`. Secrets and databases stay on the host and are excluded from app rsync. See each script for its actual exclusion list and check commands.

The new test origins retain Cloudflare Access protection and separate existing databases. Old sweat app origins serve the migration notice and a production Open Dibs button; other old APIs return 410. The legacy worker unregisters/clears old caches. Old exact token-authenticated GET/HEAD calendar feeds remain direct private proxies to their matching environments. The old marketing origin and `www.dibs.fit` temporarily redirect to the canonical landing.

`PUBLIC_HOST` controls generated links. `CALENDAR_UID_NAMESPACE` independently preserves existing calendar identities: production retains `sweat.wingfield.tech` as its permanent namespace. Do not replace it merely because the public URL changed. Tokens and existing VAPID/encryption configuration were preserved. New origins require fresh browser sign-in, installation and push permission; browser storage and installed PWAs do not move across origins. Native owner install/push/calendar checks and the 24-hour settling review remain outstanding in the migration receipt.

Team membership, configurable sharing, dashboard and activity statistics are deployed. Instructor trends compare the current 14 days with the preceding 14 days; recent-class sharing is a 30-day view, not a database retention limit. See [Teams plan](../Workstreams/PLAN-teams.md), [progress](../Workstreams/PROGRESS-teams.md), and `server/team-stats.js` for exact behavior.

The latest production release check was 121 server suites and 976 client tests across 120 files, plus client build, real Chrome checks and matching public asset hashes. These historical results do not replace checks on a changed checkout. [Testing](../TESTING.md) defines the required checks.

Legal drafts and unresolved publication decisions are under [Legal review notes](../Legal/REVIEW-NOTES.md). Approved Terms and Privacy pages are now published on the experiment deployment; production, dev and marketing have not received this policy release.

`privacy@dibs.fit` now forwards through Cloudflare Email Routing to the verified `dibsadmin@piersj.com` destination. Routing API and authoritative MX/SPF checks pass; end-to-end delivery has not been tested. Legal drafts remain unpublished.

Latest dev release: 122 server suites / 981 client tests retained from unchanged verified source; immutable Node 22.23.4 client build and served JS/CSS/Home/Teams hashes match. Dev health/internal/public and database integrity pass; environment, bind, keys and data counts preserved. Production, experiment and marketing were not deployed. Dev Chrome verifies the updated welcome through existing Access; the app account is signed out, so authenticated chart behavior is covered by the local fixture receipt.

## Experiment optional-login release (9 November 2026)

`feat/optional-gym-login-policy` is deployed to experiment only. Source remains uncommitted at `43592ebb7feb84c4e9a676c122909e5fe632ecda`; it was not pushed or merged. The [local verification receipt](../QA/browser-runs/gym-login-policy-2026-11-09/README.md) records full checks and prior Chrome flows; the [experiment deployment receipt](../QA/browser-runs/gym-login-policy-experiment-2026-11-09/README.md) records runtime health, schema/data preservation, asset hashes and Chrome signup/policy smoke. Production, dev and marketing were not changed.

Before enabling background jobs after restoring an older backup, reapply all later forget-login choices. If those choices cannot be reconciled, clear every restored reusable gym login (set `user_gyms.gym_email`/`encrypted_password` to NULL, `remember_login` to 0, and increment `connection_revision`; clear vestigial `users.encrypted_password`). Preserve encrypted provider sessions, links, settings and queues. Obtain fresh explicit choices in the normal gym-login flow; never infer permission from an old password in a backup. This procedure does not promise deletion from historical backups.

### Policy contact correction — 9 November 2026

Experiment now includes the Cloudflare email-obfuscation fix: policy-only no-transform response headers and explicit readable mailto contacts in current/dated Terms and Privacy. [Verified receipt](../QA/browser-runs/policy-email-protection-2026-11-09/README.md): 124 server suites, 990 client tests, build, 16/16 Chrome checks, health and DB integrity pass; fresh 12-user/17-link baseline preserved. No production/dev/marketing or Cloudflare configuration change. Physical iPhone verification remains outstanding.


### Choice styling and login-warning diagnosis — 9 November 2026

Experiment only now includes cohesive signup/remember-login choice cards, selected-studio marquee exit with reduced-motion/focus handling, gym names in login-required push bodies, and shared MarianaTek status propagation. Real Aarmy evidence exposed a second sync revision-fence abort after successful renewal; a bounded reread now completes that sync without relaxing stale-write protection. [Receipt](../QA/browser-runs/choice-polish-notifications-2026-11-09/README.md): 125 server suites / 993 client tests, build, 21 local Chrome + 3 Settings + 6 deployed Chrome checks, health and integrity pass; 7 source and 15 asset hashes match. The final server-only correction uses the preserved verified ARM64 image as base after Docker Hub metadata returned 429; final image `15d8b1b7748b`.

Only test3's two explicitly authorized gym links were intentionally expired: one Psycle and one Aarmy incident/push accepted by Apple; The owner confirmed that both arrived on iPhone, including Aarmy named in the Aarmy notification body. This confirms notification delivery; agent-operated physical iPhone UI testing was not performed. Both remain linked/enabled, session-only and `needs_relogin` with sessions cleared; the owner must reconnect them normally. Original valid access tokens and Aarmy refresh survived the reported provider password changes. Normal account sync cadence is 6 hours. Original encrypted scoped rows and WAL-safe/config/image rollback snapshots are retained privately on Oracle; do not automatically restore stale session state. Env/compose/keys, 12 users/18 links, bind/exposure and production/dev/marketing remain preserved.

### Reconnect design sweep — 9 November 2026

Experiment only now uses a normal registered Home connection widget, connection-only gym Settings while login is needed, and a normal scrolling gym-login submit after the Remember disclosure. The noisy paused/queue/calendar paragraph is removed. Final-source checks: 125 server suites / 996 client tests, build, 28 local Chrome and 20 deployed Chrome checks pass; 357 host source/config, 347 runtime source and 15 asset hashes match. Final full-build image `179647fb1bc2`, Node22.23.4 ARM64, zero restarts, internal/public health 200, DB integrity/counts and env/compose/bind preserved. Source remains uncommitted on `feat/optional-gym-login-policy`. Native iPhone keyboard remains a physical check. [Receipt and screenshots](../QA/browser-runs/reconnect-design-sweep-2026-11-09/README.md).
