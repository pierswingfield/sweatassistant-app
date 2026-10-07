# DEFAULT_GYM_ID removal and infra rename (2026-10-07)

Status: **code and infra FILES are done on branch `agent/psycle-naming-css-audit-f37e1a` (step 7). No host has been touched.**
The host cutover below is a runbook for the user to approve and run (dev first, then prod).

## What changed in the repo (one commit per item)

| # | Item | Outcome |
|---|------|---------|
| 1 | Welcome/About copy | No hardcoded gym names (`copy.js`). |
| 2 | Credit checkout fallback | `creditStoreUrl` (template with `{handle}`) on the gym config, exposed on `/api/gyms` only for `creditPurchase` gyms; `credits.js` reads it, falls back to `websiteUrl`. |
| 3 | Stray `psycle` core tokens | Comments and `warm-instructor-photos.js` container name made neutral. |
| 4 | `PUBLIC_HOST` / `VAPID_EMAIL` | Required when `NODE_ENV=production` (named startup error), inert localhost values in dev/test. `.env.example` added. Both prod and dev `.env` files already contain both keys (names verified read-only), so the new rule cannot break the cutover. |
| 5 | Dev mock | `devMock: { email }` per gym in `gyms.config.js`; adapter hooks `isMockLogin`, `isMockUser`, `mockToken`. `auth.js`, `poller.js`, `scheduler.js`, `codexfit.js`, `marianatek.js` updated; `dev-setup-jab.js` -> `dev-setup-gym.js`. The app-level dev bypass is now **disabled in production** (it previously accepted any password for `dev@psycle.com` in any environment). A dead helper (`poller.fetchPublicFromGym`) was deleted. |
| 6 | `DEFAULT_GYM_ID` | Removed. No linked gym => `resolveActiveGymId` is `null`, routes 409 `NO_GYM_LINKED`, settings PUT 409 for gym-scoped keys. Several links and none named => earliest link. `handleLogin` bootstrap and `db.createUser` deleted (signup is the only creator). One canonical `CREATE TABLE` block replaces WP-D1/D2/D6 migrations, `ensureColumn`, DDL defaults, backfills (schema diffed against the old fresh DB: identical except `auto_bookings.gym_id` and `auto_upgrades.gym_id` are now `NOT NULL`). `test-backfill-user-gyms.js` deleted, `server/testkit.js` added, `test-regression-psycle.js` -> `test-regression-codexfit-mock.js`. |
| 7 | Infra files | Neutral names below, `docker-compose.prod.yml` added, `deploy.sh` and backup script updated. |

New suites: `test-config-required`, `test-dev-mock-hook`, `test-no-gym-state`.
Left alone on purpose: the three settings-scope data migrations in `db.js` (no-ops on a fresh DB, still tested), the `sweat(-dev).wingfield.tech` public hostnames, historical docs under `Documentation/Archive/` and workstream records.

## Names chosen (generic `app`) and collision check

| Thing | Old | New |
|-------|-----|-----|
| Prod service / container | `psycle-app` | `app` |
| Dev service / container | `psycle-app-dev` (service was `psycle-app`) | `app-dev` |
| Remote dirs | `~/services/psycleapp`, `psycleapp-dev` | `~/services/app`, `~/services/app-dev` |
| Compose projects (auto) | `psycleapp`, `psycleapp-dev` | `app`, `app-dev` (networks `app_default`, `app-dev_default`; images `app-app`, `app-dev-app-dev`) |
| DB file | `/data/psycle.db` | `/data/app.db` |
| Unused named volume | `psycle-data` (declared, never mounted; orphan `psycleapp-dev_psycle-data`) | declaration deleted; orphan removed in the runbook |
| Backup | `psycle-backup-sqlite.sh`, `/var/backups/psycle-sqlite`, Drive `Backups/psycle-sqlite`, `psycle-*.db.gz`, `/var/log/psycle-backup-sqlite.log` | `app-backup-sqlite.sh`, `/var/backups/app-sqlite`, `Backups/app-sqlite`, `app-*.db.gz`, `/var/log/app-backup-sqlite.log` |

Collision check (read-only, 2026-10-07): oracle has no container, network, volume, image or `~/services/` entry named `app`, `app-dev`, `app_default`, `app-dev_default` or `app-data`; the Pi has `nginxproxymanager-docker-app-1` (different host, different name). Minimal disambiguation applied: **prod and dev use different service names** (`app` vs `app-dev`). Docker adds the service name as a DNS alias on every network the service joins, and the old dev and prod files both used `psycle-app` on the shared `edge` network, so the tunnel upstream `psycle-app:3000` could resolve to either container. Also note `app` is a very short name on a shared network: if another stack ever needs it, rename in one place (`docker-compose.prod.yml`, tunnel upstream, registry).

## Cutover runbook

Needs the user: every step marked **[CONFIRM]**. Nothing below has been run. Expected downtime: dev about 2 minutes, prod about 3 to 5 minutes (image build can be pre-warmed with the dev deploy; prod accounts are lost by design, so everyone signs up again and relinks gyms).

### 0. Preconditions (local)
1. Merge this branch to `master`; deploy from a clean `master` checkout (`deploy.sh` ships the working tree).
2. `npm test` green and `npm run build:client` ok.
3. `./deploy.sh --print` and `./deploy.sh --print --prod`: check the dirs and `-f` compose files.
4. Pre-flight read-only on oracle: `docker ps --format '{{.Names}}'` (confirm `psycle-app`, `psycle-app-dev`), `ls ~/services`, and confirm both `.env` files contain `PUBLIC_HOST` and `VAPID_EMAIL` (`grep -c '^PUBLIC_HOST=' ~/services/psycleapp/.env`).
5. Read the oracle tunnel's current ingress (Cloudflare API `GET /accounts/$CF_ACCOUNT/cfd_tunnel/<oracle-cloudflared id>/configurations`, token from `~/.cloudflare.env`, never print it). Record the exact upstreams for `sweat`, `sweat-dev` and `psycle` hostnames; save the JSON as a backup. The Pi tunnel is not involved.

### 1. Dev twin first
1. **[CONFIRM]** `ssh oracle 'sudo /usr/local/sbin/psycle-backup-sqlite.sh'`; verify a dated file in `/var/backups/psycle-sqlite/dev/` and on Drive (`rclone lsd`/`ls`).
2. **[CONFIRM]** Stop and move: `cd ~/services/psycleapp-dev && docker compose down`; `cd ~/services && mv psycleapp-dev app-dev`.
3. Archive the DB (no migration, the new build creates a fresh schema): `cd ~/services/app-dev && mv data data-archive-$(date +%Y%m%d) && mkdir data`. Keep `.env` as is.
4. From the Mac: `./deploy.sh` (dev). It rsyncs into `~/services/app-dev/` and runs `docker compose -f docker-compose.yml up -d --build`.
5. Verify (show the output): `ssh oracle 'docker ps --format "{{.Names}} {{.Status}} {{.Ports}}" | grep app'` shows `app-dev` Up on `100.86.226.52:3005->3000`; `curl -s https://sweat-dev.wingfield.tech/api/health` is `ok`; `docker exec app-dev ls -l /data` shows `app.db`.
6. Tunnel: the dev hostname's upstream must name the new container (`app-dev:3000`, or the tailnet bind if that is what it uses; step 0.5 tells you). **[CONFIRM]** edit via GET, modify, PUT (a PUT replaces the entire config), then re-probe the hostname.
7. Browser smoke on the dev host (real Chrome, one tab): signup, link a gym, timetable, Settings.
8. Clean up: `docker rm` is not needed (compose down removed the old container); **[CONFIRM]** `docker volume rm psycleapp-dev_psycle-data` (empty, unused) and `docker network rm psycleapp-dev_default` after `docker network inspect` shows no endpoints.
9. Install the renamed backup script (does not touch cron yet): `scp scripts/backup-sqlite.sh oracle:/tmp/ && ssh oracle 'sudo install -m 755 -o root -g root /tmp/backup-sqlite.sh /usr/local/sbin/app-backup-sqlite.sh'`. The prod source `~/services/app/data/app.db` does not exist until prod is cut over, so the first run reports `prod: source missing` and exits non-zero: expected, run it only after step 2.

Let dev run for a day before prod.

### 2. Prod (typed confirmation required)
1. **[CONFIRM]** On-demand backup with the old script (still installed): `ssh oracle 'sudo /usr/local/sbin/psycle-backup-sqlite.sh'`; verify the dated `prod` artefact locally and on Drive.
2. **[CONFIRM]** Add the compatibility alias so the tunnel keeps resolving across the rename: temporarily put `aliases: [psycle-app]` under `networks: edge:` for the `app` service in the host's copy of `docker-compose.prod.yml` after the first deploy (or run step 5 immediately after step 4 to keep the gap to seconds). Skipping the alias means 502s on `sweat.wingfield.tech` until step 5.
3. **[CONFIRM, destroys all prod accounts]** `cd ~/services/psycleapp && docker compose down && cd .. && mv psycleapp app && cd app && mv data data-archive-$(date +%Y%m%d) && mkdir data`. The old compose file left in the dir is `docker-compose.yml`; prod now uses `docker-compose.prod.yml`, so `mv docker-compose.yml docker-compose.yml.old-psycle`.
4. **[CONFIRM, typed "deploy prod"]** `./deploy.sh --prod` from the Mac.
5. **[CONFIRM]** Tunnel upstream for `sweat` (and `psycle` if kept, see step 8) from `psycle-app:3000` to `app:3000` (GET, back up, modify, PUT). Then remove the alias from the host compose and `docker compose -f docker-compose.prod.yml up -d`.
6. Verify (show the output): `docker ps` shows `app` Up with no published port; `curl -s https://sweat.wingfield.tech/api/health` ok; `docker exec app wget -qO- localhost:3000/api/gyms` lists the expected gyms; `docker exec app ls -l /data` shows `app.db`; browser smoke (signup, link, timetable) on a clean cache (service worker, CacheStorage, IndexedDB all cleared).
7. Cron: **[CONFIRM]** edit root crontab (absolute paths, always redirect): replace the two `psycle-backup-sqlite.sh` lines with `/usr/local/sbin/app-backup-sqlite.sh >> /var/log/app-backup-sqlite.log 2>&1` (04:10) and the `--check-stale` line (09:30). Also `grep -n psycleapp /usr/local/sbin/oracle-backup.sh` and update its source list (not read yet). Verify by artefact the next morning: dated `app-*.db.gz` under `/var/backups/app-sqlite/{prod,dev}` and `Backups/app-sqlite/{prod,dev}` on Drive (not by absence of an alert).
8. Hostname retirement: the user decided to retire `psycle.wingfield.tech`. **[CONFIRM]** remove the tunnel ingress rule and DNS record for `psycle.wingfield.tech`, and remove it from the `psycle` Cloudflare Access app (hostnames `psycle`, `sweat`, `sweat-dev`); keep `psycle-bypass` for the `sweat` paths (`/api/calendar/*`, `/api/health`) and drop its `psycle` host. Warning: **calendar feed URLs and Chrome-extension API calls on the old host stop working**; `PUBLIC_HOST` already points at the sweat host in prod `.env`, so new feed URLs are correct, but any old subscription URL dies. Optional: rename the Access apps (cosmetic).
9. Later, after a week and only on explicit say-so: delete `~/services/app/data-archive-*`, `docker-compose.yml.old-psycle`, Drive `Backups/psycle-sqlite`, local `/var/backups/psycle-sqlite`, `/usr/local/sbin/psycle-backup-sqlite.sh`, and the stopped Pi `psycle-app` container with `~/psycleapp`.

### 3. Rollback
- Dev or prod before step 2.4: `docker compose down` in the new dir, `mv` the dir back, `rm -r data && mv data-archive-<date> data`, restore the old compose file, `docker compose up -d`. The archived DB is `psycle.db`; the previous image still needs `DB_PATH=/data/psycle.db` (it has it baked in), so use the previous commit if you rebuild. Restore the saved tunnel JSON (PUT).
- After prod accounts have re-signed up: rollback loses those accounts again; the pre-cutover backups on Drive and in `/var/backups/psycle-sqlite` are the only restore points.
- Previous known-good code: current `master` before this merge (the `psycle` names).

### 4. Registry and docs edits needed (do NOT edit `~/.claude` files until the cutover happens)
In `~/.claude/skills/selfhost-deploy/references/registry.md`:
- Rows `psycle-app` / `psycle-app-dev` (lines about 73-74): container `app` / `app-dev`, compose project `app` / `app-dev`, container-name column `app-app` / `app-dev-app-dev`, dir `~/services/app*`, note the alias removal and the dropped `psycle.wingfield.tech` host.
- Docker networks line (about 188): `app_default`, `app-dev_default` replace `psycleapp(_dev)_default`.
- Pi standby row (about 159) unchanged until it is deleted.
- Add a dated cutover note in the latest-deploy block with commit, backup artefacts and verification output.
Also: `oracle.md` lines about 110 and 216-226 (script name, paths, `app.db`, log, Drive folder), `cloudflare.md` lines about 37-38 and 93-94 and 141 (hostname set, Access app names), `pi.md:47` (example dir), the memory file `sqlite-backups-oracle.md`, and `Server Management/CHANGELOG.md`.

## Decisions still open
1. Rename the public hostnames (`sweat.wingfield.tech`, `sweat-dev.wingfield.tech`)? Left unchanged; they are brand-ish names.
2. Keep the Access apps named `psycle` / `psycle-bypass` (cosmetic) or rename.
3. Whether `app` is acceptable as a bare DNS name on the shared `edge` network, or prefer a longer neutral name (one-place rename).
