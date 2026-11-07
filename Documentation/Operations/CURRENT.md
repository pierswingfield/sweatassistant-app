# Current Dibs operations

As of 2026-11-07. This is the entry point for current deployment facts; dated audits and launch receipts describe their own inspection time.

| Surface | Canonical origin | Existing Oracle container |
|---|---|---|
| Marketing | https://dibs.fit | `dibs-landing` |
| Production | https://app.dibs.fit | `sweatassistant` |
| Dev | https://dev.dibs.fit | `sweatassistant-dev` |
| Experiment | https://experiment.dibs.fit | `sweatassistant-experiment` |

The current source is `teams` in worktree `App-teams`, pushed to `origin/teams`, unmerged into `master`. Production now runs the Sol onboarding/app design refinement `4e92430`; see the [verified receipt](../QA/browser-runs/sol-design-implementation-2026-11-07/README.md). All five configured gyms are enabled, including Homerun and Barry’s. Landing remains on UI/copy release `c98ef9a`; see the [polish receipt](../QA/browser-runs/onboarding-share-polish-2026-11-07/README.md). Dev/experiment remain on domain release `964e04f`; the [migration receipt](../QA/browser-runs/domain-migration-2026-11-07/README.md) establishes their baseline. Later documentation-only changes do not change deployed application code. Do not infer current remote health from this document: verify it when operating on a host.

`deploy.sh` defaults to dev; `--experiment` selects experiment and `--prod` selects production with typed confirmation. `deploy-landing.sh` selects the landing site. Scripts ship the working tree, so inspect its exact diff and target first. Load the `selfhost-deploy` skill before host work; keep its service registry current with infrastructure changes. All existing hosts are ARM64; use `docker compose`. Secrets and databases stay on the host and are excluded from app rsync. See each script for its actual exclusion list and check commands.

The new test origins retain Cloudflare Access protection and separate existing databases. Old sweat app origins serve the migration notice and a production Open Dibs button; other old APIs return 410. The legacy worker unregisters/clears old caches. Old exact token-authenticated GET/HEAD calendar feeds remain direct private proxies to their matching environments. The old marketing origin and `www.dibs.fit` temporarily redirect to the canonical landing.

`PUBLIC_HOST` controls generated links. `CALENDAR_UID_NAMESPACE` independently preserves existing calendar identities: production retains `sweat.wingfield.tech` as its permanent namespace. Do not replace it merely because the public URL changed. Tokens and existing VAPID/encryption configuration were preserved. New origins require fresh browser sign-in, installation and push permission; browser storage and installed PWAs do not move across origins. Native owner install/push/calendar checks and the 24-hour settling review remain outstanding in the migration receipt.

Team membership, configurable sharing, dashboard and activity statistics are deployed. Instructor trends compare the current 14 days with the preceding 14 days; recent-class sharing is a 30-day view, not a database retention limit. See [Teams plan](../Workstreams/PLAN-teams.md), [progress](../Workstreams/PROGRESS-teams.md), and `server/team-stats.js` for exact behavior.

The latest production release check was 121 server suites and 976 client tests across 120 files, plus client build, real Chrome checks and matching public asset hashes. These historical results do not replace checks on a changed checkout. [Testing](../TESTING.md) defines the required checks.

Legal drafts and unresolved publication decisions are under [Legal review notes](../Legal/REVIEW-NOTES.md). They are not published policies.

`privacy@dibs.fit` now forwards through Cloudflare Email Routing to the verified `dibsadmin@piersj.com` destination. Routing API and authoritative MX/SPF checks pass; end-to-end delivery has not been tested. Legal drafts remain unpublished.
