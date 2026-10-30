# Experimental redeployment — 2026-10-30

Deployed application commit `42bb5c18dfbc2237f2744e5abe8c7e2246b539b1` using `./deploy.sh --experiment`. No dev or production deployment or live gym writes were performed. The Homerun and Barry's flags remained enabled only in experiment. The existing Barry's link, empty auto-book queue and two stopped upgrade monitors remained unchanged.

Public health returned OK. The replacement container ran Node 22.23.4, had zero restarts and no recent error-like log entries; the tailnet bind and hostname were unchanged, and Oracle had 5.0 GB free. Real Chrome loaded experiment and measured the served Barry's vector as centered, with settings widths 80/84 px and compact widths 48/40 px for Barry's/Aarmy. Signed-in experimental screens were not exercised; the settings screens and both themes were verified against isolated mock data before deployment.

The pre-deploy image is tagged `sweatassistant-experiment-sweatassistant-experiment:rollback-20261030-logo` (`sha256:6e0d7f00a562d1823b794ccfbaafa7f5587a223aad28a1f48d0dd1b5d38c8210`). An integrity-checked SQLite snapshot, environment copy and source archive are retained on Oracle at `~/services/sweatassistant-experiment-rollback-20261030-logo-alignment/`. Restore the previous image and environment for rollback; restore the database only when deliberately required, to avoid losing subsequent account data.

The self-host registry is in another existing worktree and was not modified. Update its experiment entry separately with this deployed commit, unchanged host/bind, enabled experiment-only flags, preserved inactive jobs and the rollback information above.
