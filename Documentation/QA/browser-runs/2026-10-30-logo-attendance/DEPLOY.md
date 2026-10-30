# Experimental deployment: Barry's mark and attendance availability

2026-10-30. Application commit `5d268064f488bacafb7f6e442418c346beb97984` deployed only to https://sweat-experiment.wingfield.tech using `./deploy.sh --experiment`.

Public health returned OK; the container is running with zero restarts. Both experimental gym flags are enabled. Barry's existing link remains present; there are no auto-book rows and both auto-upgrade rows remain stopped. No authenticated gym-history request or gym write was performed.

The user's Chrome rendered the deployed versioned SVG both as the shared inline sprite structure and as an external image; [the comparison](deployed-sprite-comparison.png) shows centered identical artwork. This was a synthetic safe comparison in a separate browser tab, not a signed-in experimental session. Real Chrome mock screenshots in this directory cover Home, header, Your Gyms, settings and light/dark layouts. Attendance behavior was verified with mock data; actual Barry's attendance totals remain unsupported pending provider verification.

Before deployment, an integrity-checked SQLite backup, previous source and environment were saved in `~/services/sweatassistant-experiment-rollback-20261030-sprite-attendance` on the host, and the prior image was tagged `sweatassistant-experiment-sweatassistant-experiment:rollback-20261030-sprite`. Current image is `sha256:7926bfcfb0c35025c329a096bf79e2e9a800f7dac0a67f4bbd5dca59e818790a`.

The separate service registry is a protected existing worktree and was not modified. Its experiment entry should record this application commit and rollback location when that worktree may be updated.
