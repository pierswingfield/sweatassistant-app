# Handoff: fix backups and notifications after the sweatassistant rename/cutover

Written 2026-10-08 ~19:05 BST from read-only inspection of oracle and pi. Labels: CURRENT (seen live), PLANNED (runbook `Documentation/Audits/default-gym-and-infra-plan.md`, not done), IN-FLUX (another agent is mid-cutover; re-check before acting).

## 1. Naming map (old -> new)

| Thing | Old | New | State |
|---|---|---|---|
| Public hosts | `sweat.wingfield.tech`, `sweat-dev.wingfield.tech` | unchanged | CURRENT |
| Retired host | `psycle.wingfield.tech` (still on prod tunnel + Access app `psycle`) | removed | PLANNED (runbook prod step 8) |
| Prod container/service | `psycle-app` (image `psycleapp-psycle-app`, Up 2 days, no host port) | `sweatassistant` (`docker-compose.prod.yml`) | prod still OLD; `~/services/sweatassistant/` holds only `.env` + empty `data/` (IN-FLUX) |
| Dev container/service | `psycle-app-dev` | `sweatassistant-dev` (image `sweatassistant-dev-sweatassistant-dev`, `100.86.226.52:3005->3000`) | CURRENT (renamed 2026-10-08 ~17:48) |
| Host dirs | `~/services/psycleapp`, `~/services/psycleapp-dev` | `~/services/sweatassistant`, `~/services/sweatassistant-dev` | dev DONE; prod PLANNED; `~/services/psycleapp` still exists and is live |
| DB file | `data/psycle.db` | `data/app.db` (`./data` -> `/data`) | dev: `app.db` is live; prod: still `psycle.db` |
| Compose projects/networks | `psycleapp(_dev)_default` | `sweatassistant(-dev)_default` | dev DONE |
| Shared network | `edge` (external) | unchanged | CURRENT |
| Tunnel upstream | `http://psycle-app:3000` (prod), dev now `http://sweatassistant-dev:3000` | prod -> `http://sweatassistant:3000` | PLANNED (runbook prod step 5; alias `psycle-app` bridges the gap) |
| Named volume `psycle-data` | declared, unused | deleted | orphan `psycleapp-dev_psycle-data` removal PLANNED |
| Pi | `~/psycleapp`, container `psycle-app` (Exited 137, 2 months, standby) | same sweatassistant naming for any future use | CURRENT: stopped; delete only on explicit say-so |

Dev data dir still has legacy files beside the live `app.db`: `psycle.db`(+wal/shm, 2.3MB, last write 14:51), `psycle.db.bak-*`, `psycle-u4-17-predeploy-20260929-191104.db.gz`. Do not delete.

## 2. Directory layout

Oracle (ssh oracle, user ubuntu, host TZ Europe/London):
- Prod CURRENT: `/home/ubuntu/services/psycleapp/{.env,data/psycle.db(-wal,-shm)}`, owner root for DB files; `.env.bak-20261006*`, `data-archive-20261006/`.
- Prod PLANNED: `/home/ubuntu/services/sweatassistant/{.env,data/app.db}`. After the runbook: old `data` moves to `data-archive-YYYYMMDD`, fresh `data/` created, so prod DB is brand new (all prod accounts lost, backups are the only restore points).
- Dev CURRENT: `/home/ubuntu/services/sweatassistant-dev/{.env(600),data/app.db,docker-compose.yml}`.
- `.env` key names (no values): NODE_ENV PORT JWT_SECRET ENCRYPTION_KEY VAPID_EMAIL ADMIN_PASSWORD APP_NAME PUBLIC_HOST JAB_BOXING_ENABLED AARMY_ENABLED. No VAPID_PUBLIC/PRIVATE in env, so keys live in DB `server_kv`.
- Scripts in `/usr/local/sbin/` (root): `psycle-backup-sqlite.sh` (OLD, modified 2026-10-08 19:01, see below), `psycle-backup-sqlite.sh.pre-rename` (pristine original, 2026-09-28), `sweatassistant-backup-sqlite.sh` (NEW, 19:01, installed, not in cron), `oracle-backup.sh` (+ `.bak-2026-08-06`, `.bak-20260928`).
- Backup dirs: `/var/backups/psycle-sqlite/{prod,dev}/` (700, root) holding `psycle-YYYYMMDD-HHMMSS.db.gz` and `last-success` stamp (touched 19:02). `/var/backups/sweatassistant-sqlite/` does NOT exist yet (script creates it). Also `/var/backups/oracle/<date>`.
- Logs: `/var/log/psycle-backup-sqlite.log` (root, 644, last write 09:30); `/var/log/sweatassistant-backup-sqlite.log` not yet created; `/var/log/oracle-backup/<date>.log`. No logrotate entry exists for either sqlite log.
- Root crontab (CURRENT, user root, no MAILTO, no mail spool):
  - `30 3 * * * /usr/local/sbin/oracle-backup.sh >/dev/null 2>&1` (note: discards output, breaks rule 9; it logs to its own file)
  - `10 4 * * * /usr/local/sbin/psycle-backup-sqlite.sh >> /var/log/psycle-backup-sqlite.log 2>&1`
  - `30 9 * * * /usr/local/sbin/psycle-backup-sqlite.sh --check-stale >> /var/log/psycle-backup-sqlite.log 2>&1`
  - ubuntu crontab: keepalive-ping.sh (*/10), check-whatsapp-auth.sh (*/15); unrelated. No systemd timer concerns the app backups.

IN-FLUX WARNING: the host copy of `psycle-backup-sqlite.sh` (OLD name) was edited at 19:01 so SRC is `prod=~/services/psycleapp/data/psycle.db`, `dev=~/services/sweatassistant-dev/data/app.db`, mixed state that still writes `psycle-*.db.gz` into `/var/backups/psycle-sqlite` and Drive `psycle-sqlite`. The dev source is correct, prod is correct until prod cutover. Two manual runs at 19:01 and 19:02 produced files `psycle-20261008-1901xx/1902xx.db.gz` (prod ~5KB, dev 82KB, dev now `app.db` which is smaller than the 400KB seen earlier, expected since dev DB was recreated 2026-10-07/08).

Google Drive (rclone remote `gdrive_pierswingfield:`, root's config `/root/.config/rclone/rclone.conf`; also crypt remote `gdrive_crypt:` -> `gdrive_pierswingfield:/Backups/oracle-crypt`):
- CURRENT: `Backups/psycle-sqlite/{prod,dev}/` (rclone `copy`, remote prune `--min-age 30d`, so no mirror deletes). Listing showed files through at least 2026-09-28 plus the dated ones since.
- PLANNED: `Backups/sweatassistant-sqlite/{prod,dev}/` (does not exist yet; `rclone lsd` returns "directory not found").
- Retention: local 14 days (`find -mtime +13`), remote 30 days.
- Other Drive folders: `oracle`, `oracle-crypt`, `oracle-logs`, `raspibackup`, `TimeMachine`, `vaultwarden`, `rclonelogs`.

Pi: nothing app-specific. Dir `/home/pi/psycleapp` (stopped container `psycle-app`). Pi root cron: Monday 03:00 `backuptodgrive.sh`, daily 09:00 `check-backup-freshness.sh` (ntfy, 8-day stale) logging to `/var/log/backuptodgrive.log`. No sweat/psycle references in those scripts.

## 3. Backup pipeline

Source of truth: repo `scripts/backup-sqlite.sh` (already updated to new names). Flow per env in {prod,dev}: `sqlite3 SRC ".timeout 10000" ".backup tmp"` (WAL-safe, no container stop) -> `PRAGMA integrity_check` must equal `ok` else delete copy + fail -> `gzip -9` + `gzip -t` -> prune local >14d -> `rclone copy` to Drive + `rclone delete --min-age 30d`. Success touches `$ROOT/last-success`; any failure sends ntfy and exits 1. `--check-stale` (09:30) alerts if stamp older than 30h. Never copies `.env`.

Second, separate backup: `oracle-backup.sh` (03:30) runs `dump_sqlite /home/ubuntu/services/psycleapp/data/psycle.db psycleapp` (line 155) and tars `~/services` configs (includes every `.env`, hence the crypt remote). STALE after the cutover; the dev DB is not in its list. Update path to `~/services/sweatassistant/data/app.db` and label, test that `sqlite/` output in `/var/backups/oracle/<date>` has the new file. Its tar hot-copies `psycleapp` dir; no name change needed but the renamed dir is covered by the services glob (verify).

Checklist of everything needing change:
1. Cron: replace two `psycle-backup-sqlite.sh` lines with `/usr/local/sbin/sweatassistant-backup-sqlite.sh` (04:10, and `--check-stale` 09:30), logs to `/var/log/sweatassistant-backup-sqlite.log`. Absolute paths, always redirect (rule 9).
2. First run of the new script reports `prod: source missing` until prod cutover creates `~/services/sweatassistant/data/app.db`. Do not enable cron before then, or temporarily accept the failure ntfy; decide with the user.
3. Seed `last-success` in the new ROOT (or copy old stamp) so the stale check does not fire spuriously, and consider copying the existing `psycle-*.db.gz` into `/var/backups/sweatassistant-sqlite/` (copy, never move or delete the old ones).
4. `/usr/local/sbin/oracle-backup.sh` line 155 source path (above), plus add dev if desired.
5. `deploy.sh` (repo): no pre-deploy backup call exists; docs say run on demand. Update docs/runbook to `ssh oracle 'sudo /usr/local/sbin/sweatassistant-backup-sqlite.sh'` (Documentation/Audits plan step "On-demand backup with the old script", dev step 1 and prod step 1).
6. Docs: memory note `~/.claude/projects/-Users-pierswingfield-Desktop-AI-Projects-psycle-chrome-App/memory/sqlite-backups-oracle.md` (script path, dirs, Drive path, on-demand command); `~/.claude/skills/selfhost-deploy/references/registry.md` (rows `psycle-app`, `sweatassistant-dev`, networks line, add dated note); `references/oracle.md` lines ~110 and 216-226; `references/cloudflare.md` ~37-38, 93-94, 141; `references/pi.md:47`; `~/Desktop/AI Projects/Server Management/CHANGELOG.md`; repo `Documentation/Workstreams/C1-critical-fixes.md` (C1-5 restore header; the script `--help` points to it) and `Documentation/TESTING.md`/AGENTS.md if they mention backups.
7. Retire old only on explicit say-so, after a week: `psycle-backup-sqlite.sh*`, `/var/backups/psycle-sqlite`, Drive `Backups/psycle-sqlite`, `~/services/psycleapp`. Never delete old backups before then.
8. Optional hardening: add logrotate for both sqlite logs, make `oracle-backup.sh` cron stop discarding output.

## 4. Notifications

Backup alerts (CURRENT): all via ntfy.sh topic `<NTFY_TOPIC>` (set in the script on the host; the topic name acts as the access key on the public ntfy.sh, so it is not recorded here) (public service, `curl` POST, titles `[oracle] Sweat SQLite backup: FAILED|STALE` and `[oracle] Backup Failed`). Used by `backup-sqlite.sh`, `oracle-backup.sh` and the Pi's `check-backup-freshness.sh`. The topic name is not a rename casualty. Message text in the old script said "psycle SQLite" (the new repo script says "SQLite"); ntfy titles say "Sweat". No MAILTO, healthchecks.io, Pushover or Telegram found in these scripts. Not determined: whether the phone's ntfy subscription filters by title; whether Home Assistant or any dashboard consumes the topic (HA MCP timed out).
Monitors found: no Uptime Kuma/Gatus container on oracle (docker ps grep). The only health consumers seen are `deploy.sh`'s final printed `curl` hints (`https://sweat.wingfield.tech/api/health`, `https://sweat-dev.wingfield.tech/api/health`) and the in-app `/api/health` heartbeat. External monitors outside these hosts (Cloudflare health checks, phone apps) were not determined; check Cloudflare dashboard for notifications on the old `psycle.wingfield.tech` host.
App push (VAPID): keys are not in `.env` (only `VAPID_EMAIL`); `server/push.js` auto-generates and stores them in DB `server_kv` (`vapid_public_key/private_key`). When prod gets a fresh `data/` at cutover, new keys are generated, all `push_subscriptions` vanish, and every user must re-subscribe (they re-signup anyway). Dev already had a fresh `app.db`. `VAPID_EMAIL` (mailto: or https://) and `PUBLIC_HOST` are required in production and exist in all three `.env` files. The notification dedupe and calendar feed URLs use `PUBLIC_HOST`, already the sweat host. Retiring `psycle.wingfield.tech` kills old calendar `.ics` URLs and Chrome-extension API calls.
Reminder: the app has no outbound alerting of its own for backups.

## 5. Acceptance tests for the fixing agent

1. Run `sudo /usr/local/sbin/sweatassistant-backup-sqlite.sh` once after the prod cutover; log shows `prod: ... integrity_check=ok`, `dev: ... integrity_check=ok`, `uploaded to .../sweatassistant-sqlite/{prod,dev}/`, `=== OK ===`. Show `ls -l` of both local dirs and `rclone lsl` of both Drive dirs (dated today, non-zero size).
2. Integrity: `gunzip -c <latest> > scratch.db; sqlite3 scratch.db 'PRAGMA integrity_check; select count(*) from users;'`.
3. Failure alert without harm: run with a copy of the script (or `SRC` env override on a temp copy) pointing at a nonexistent source path, in a scratch ROOT; confirm exit 1 and an ntfy message arrives (check the phone or `curl -s ntfy.sh/<NTFY_TOPIC>/json?poll=1&since=5m`). Likewise test `--check-stale` by `touch -d '40 hours ago'` on a scratch stamp only, never on the real one. Do not touch real data or the real stamp.
4. Restore test: decompress the latest prod backup into a scratch dir, start a throwaway container from the current image with `-v scratch:/data`, different name and port (not on `edge`), require `/api/health` 200 and matching row counts; then remove the scratch container only.
5. `crontab -l` as root shows only the new lines; next morning verify by artefact: a `sweatassistant-*.db.gz` from 04:10 locally and on Drive, and `stale-check OK` at 09:30.
6. `oracle-backup.sh`: after a run, new log under `/var/log/oracle-backup/` ends `=== OK`, and the sqlite dump of the new path exists.

Constraints: read-only until the cutover agent finishes (check `docker ps`, `ls ~/services`, tail of the plan doc); no prod container changes outside the cutover; never delete old backups or `data-archive-*`; no secret values in output (never print `.env`, rclone.conf, tunnel token); update `registry.md` in the same turn as any host change and append to Server Management CHANGELOG; ask before enabling anything exposed or touching Cloudflare/tunnel; use `docker compose`, never `docker-compose`; do not commit this file.
