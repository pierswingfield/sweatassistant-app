# Experimental redeployment — 2026-10-30

Deployed application commit `61343886fc69dc83fd9b128111c3d007261d4c30` using `./deploy.sh --experiment`. No dev or production deployment or live gym writes were performed. The existing experimental Homerun and Barry's flags stayed enabled. The one Barry's link, empty auto-book queue and two stopped upgrade monitors remained unchanged.

Public health returned OK. The replacement container ran Node 22.23.4, had zero restarts and no recent error-like log entries. The existing tailnet bind and hostname did not change; Oracle had 5.0 GB free after the build. In real Chrome, a synthetic field using the deployed modal classes was above the backdrop and focusable. The deployed Barry's configuration exposes `/gyms/barrys-mark.svg` and a 48 px timetable width; the unchanged full drawer wordmark is `/gyms/barrys-wordmark.svg`, and the mark returned HTTP 200. Signed-in experimental interaction was not performed.

The pre-deploy image is tagged `sweatassistant-experiment-sweatassistant-experiment:rollback-20261030` (`sha256:45d7a9fb3271ce3c28bfc10c8a22ebbf8cdf581315f35b07fd227a2c9a567826`). An integrity-checked SQLite snapshot, environment copy and source archive are retained on Oracle at `~/services/sweatassistant-experiment-rollback-20261030-visual-fixes/`. A rollback should restore the previous experimental image and environment without overwriting later account data unless a database restoration is explicitly required.

The self-host registry lives in another existing worktree and was not modified. Its experimental-service entry should be updated separately with this deployed commit, unchanged hostname/bind, enabled experiment-only flags, preserved inactive jobs and the rollback information above.
