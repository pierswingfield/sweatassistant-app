# Optional gym login and policy acceptance — experiment deployment

Deployed 9 November 2026 to Oracle experiment only: `https://experiment.dibs.fit`, container `sweatassistant-experiment`.

## Source and scope

- Branch: `feat/optional-gym-login-policy`.
- Base commit: `43592ebb7feb84c4e9a676c122909e5fe632ecda`.
- The deployed source was the uncommitted working tree; it was neither pushed nor merged. `./deploy.sh --experiment` ships that working tree and excludes `.env`, `data/`, dependencies, build output, and Git metadata.
- No production, dev, marketing, DNS, Access, or live gym state was changed.

## Pre-deploy preservation

The experiment container was Up with restart count 0, bound only to `100.86.226.52:3006->3000/tcp`, attached to `edge` and its project network. Before deployment `docker diff` showed `A /data`; the only additional `/tmp` entries were the temporary SQLite online-backup file created for this release. The pre-deploy database backup passed `PRAGMA integrity_check` and contained 11 users. Rollback artifacts are at `~/services/sweatassistant-experiment/rollback-gym-login-policy-experiment-20261109/`: `app.db`, `env.snapshot` (mode 600), compose file, and previous image ID. The previous image is tagged `sweatassistant-experiment:rollback-gym-login-policy-20261109`.

## Deployment and verification

`./deploy.sh --experiment` completed. Docker built the client (133 transformed modules, 3.67 s) and recreated only the experiment container. The existing Vite dynamic/static import and >500 kB chunk warnings remain. The deploy script's Node version check passed.

The unchanged source had already passed **124/124 server suites and 123/123 client test files / 990/990 client tests**, plus a successful client build, as recorded in the implementation receipt. Those tests were not rerun for deployment; Docker's fresh client build completed during this release.

Post-deploy runtime checks are recorded in [runtime-verification.txt](runtime-verification.txt). The container runs ARM64 `aarch64`, Node v22.23.4, restart count 0, expected tailnet-only port mapping, and is attached to `edge` plus `sweatassistant-experiment_default`. Internal and public `/api/health` returned HTTP 200; health JSON reported `status: ok` with scheduler, poller and calendar healthy. The writable-layer diff is only `A /data`.

SQLite integrity is `ok`; the database still has 11 users and 16 gym links, matching the pre-deploy user count and backup. The expected storage/consent schema is present. The `.env` and experiment compose hashes match their pre-deploy snapshots. Local-built and in-container hashes match for the main JS, CSS, Terms and Privacy assets.

## Real Chrome smoke

Used one owned Chrome CDP tab and closed it after capture. The experiment app loaded through the existing Cloudflare Access session. `/policies/terms.html` rendered “Terms and Conditions” with published version/date; then the welcome and Create Account views loaded. Signup showed the separate Dibs-account explanation, required checkbox unchecked by default, and both policy links. The screenshot [experiment-chrome-policy.png](experiment-chrome-policy.png) captures the published page; [experiment-chrome-signup.png](experiment-chrome-signup.png) captures signup; [experiment-chrome-app.png](experiment-chrome-app.png) captures the welcome view. Browser resource entries confirmed the served JS and CSS names matched the built assets.

Signup was not submitted: its final action accepts the legal terms, and the smoke did not include explicit per-action approval for that acceptance. An authenticated Dibs account was not available in the isolated experiment browser context, so the post-login gym remember/forget flow was not repeated on experiment. Its local Chrome evidence and the final full suites/build are in the [implementation receipt](../gym-login-policy-2026-11-09/README.md).

No booking, cancellation, purchase, push send, message, signup, or account-data mutation was performed. Raw runtime checks and screenshots are retained beside this receipt.

The pre-deploy and post-deploy logs include an AARMY `listReservations` HTTP 401 for existing test user 2. The same failure was present before deployment; health remained HTTP 200 and the worker services reported healthy. No credentials were retried or changed during verification.
