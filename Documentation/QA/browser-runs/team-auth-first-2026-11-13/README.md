# Team auth-first install flow — 13 November 2026

## Release

Deployed the frozen, uncommitted `fix/home-team-join-2026-11-12` working tree at HEAD `d4c8233` to Oracle `sweatassistant-experiment` only. The change moves account login/signup before the Team invite install offer. It also routes resumed legacy anonymous install progress through account access and guards the standalone prelogin install helper.

Owner-operated native verification is now complete for the auth-first path: Safari invite → account signup → install offer → Add to Home Screen → open the installed PWA and log in → finish gym/name/features setup → Team welcome. The trusted Continue tap occurred at 16:53:48.308 UTC; the 16:54:09.175 UTC snapshot showed `/teams`, Team welcome visible, pending signup cleared, and no errors. The loaded bundle was `index-DwWmGoUw.js`. This verifies the tested auth-first path on this device; it does not establish that an invite survives a fresh PWA launch before authentication and installation. A separate fresh PWA launch before login again lost the invite continuation; logging into the same account restored its pending setup. The earlier Home-only result remains unexplained and unreproduced in this successful flow. See [the routing investigation](../team-welcome-routing-2026-11-13/README.md).

## Checks

- `npm test`: 129/129 server suites; 128 client files / 1,025 tests passed.
- Client build passed in 1.55s with the existing chunk-size warning.
- `git diff --check` passed.
- Root's local real-Chrome checks are recorded in the final test output.

See [test output](test-output.txt) and [build output](build-output.txt).

## Deployment and runtime

- Image: `sha256:877d245f33e6ce73b64b62518b3a513a798b1c0f09aaf7120fda6b402db2bae5`.
- Container: ARM64 / Node `v22.23.4`, Up, restart count 0.
- Existing `100.86.226.52:3006->3000` tailnet bind, `edge` and project networks are unchanged.
- `.env` and compose SHA-256s are unchanged.
- Internal and public `/api/health` returned HTTP 200; scheduler, poller and calendar were healthy.
- `index-DwWmGoUw.js` was served with HTTP 200 at 752,304 bytes; SHA-256 `5bd89533dcaf1e4fff97ddda8496c48f04ab5f80fdf95c4173f38195200e2dba`, matching local build output.
- Before owner testing, SQLite `integrity_check` returned `ok`; deployment baseline counts were 14 users / 18 gym links / 4 teams / 0 pending signup-onboarding rows. Owner testing created a disposable account; fixture ID 15 was removed after confirming it had no memberships, join requests, gym links, or pending signup. The completed owner-test account, fixture ID 16, remains signed in on the phone for visual review; its pending row is cleared and it has no Team membership or join request. Post-cleanup SQLite integrity is `ok`, with 14 users / 18 gym links / 4 teams / 0 pending signup-onboarding rows. The original account ID 13 was preserved.
- Final source manifest: 543 local source files, all present remotely; two remote-only legacy Homerun WebPs remain due to rsync preserving remote files. Runtime manifest: 496 files, exact local/container match. 57 current static assets match. The service worker uses its expected per-build cache stamp.
- Production, dev and landing container IDs and start times remained unchanged.

See [deploy output](deploy-output.txt), [runtime verification](deploy-runtime-output.txt), [source/asset verification](source-asset-verification.txt), and the full [source manifest](source-manifest-final.txt), [runtime manifest](runtime-source-manifest.txt), [local asset manifest](local-build-asset-manifest.txt) and [container asset manifest](container-asset-manifest.txt).

## Rollback

The predeploy WAL-safe database, environment, compose, source snapshot and prior image are retained at `~/services/sweatassistant-experiment/rollback-team-auth-first-20261113/`; image tag `sweatassistant-experiment:rollback-team-auth-first-20261113` points to the previous experiment image.

Approved sanitized evidence files are `auth-first-logged-in-invite.json`, `auth-first-pwa-fresh-before-login.json`, `auth-first-pwa-physical-finish-trace.json` and `auth-first-pwa-physical-welcome.png`. The unfinished Safari signup/install trace was empty and is not included. A page-memory trace cleanup attempt timed out while the phone was locked; do not infer that every temporary device trace was removed. No deployment instrumentation was added.

Production, dev, marketing, Cloudflare/DNS, Access policy, binds and networks were not changed. No live gym/provider writes were performed.
