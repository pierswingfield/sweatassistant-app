# Experimental deployment — 2026-10-29

Deployed clean application commit `09934b2c89300aab8ce768962f46bb2fcae2e597` to the existing `sweatassistant-experiment` container using `./deploy.sh --experiment`. Dev and production were not deployed. `HOMERUN_ENABLED=true` and `BARRYS_UK_ENABLED=true` were set only in the experiment environment so the user can evaluate the integrations. The default values in source remain off. Neither new gym had a linked account before deployment; the experiment database had no auto-book rows and two stopped upgrade rows, unchanged after deployment.

Public and tailnet health reported OK. The new image is `sha256:45d7a9fb3271ce3c28bfc10c8a22ebbf8cdf581315f35b07fd227a2c9a567826`; Node is 22.23.4, the container had zero restarts and no recent error-like log entries. The existing tailnet bind and Access-protected public hostname were unchanged. Oracle had 6.0 GB available after the build.

Real user Chrome loaded the [sign-in screen](sign-in.png) at the experiment's tailnet address. In that page, the catalogue included `homerun-london` and `barrys-uk`, and both gyms' wordmarks and marks returned HTTP 200 with image content types. The public hostname redirected this Chrome session to Cloudflare/Google sign-in; authenticated app flows were not checked. No live gym booking, cancellation or other gym write was performed.

The rollback snapshot is on Oracle at `~/services/sweatassistant-experiment-rollback-20261029-guest-switch/`: it contains the pre-deploy SQLite backup (integrity checked), source archive and environment copy. The prior image is tagged `sweatassistant-experiment-sweatassistant-experiment:rollback-20261029` (image `sha256:2f03f29a39ac922ce0a848ac056debfe76437715ce519197ff611c7c55a458af`). A rollback should restore the prior experimental environment and image, without overwriting post-deploy data unless a database restoration is deliberately required.

## Registry update to apply separately

The self-host registry belongs to the existing `skills` Git worktree, which the user instructed us not to modify. Update its `sweatassistant-experiment` row to record this release, the existing Access-protected hostname and tailnet bind, the two enabled experiment-only gym flags, the unchanged inactive automation counts, and the rollback image and snapshot above. The row's statement that `deploy.sh` has no experiment target is stale: the deploy uses `--experiment`. No port, network, hostname or exposure changed.
