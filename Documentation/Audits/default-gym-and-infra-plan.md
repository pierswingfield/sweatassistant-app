# DEFAULT_GYM_ID removal and infra rename plan (READ-ONLY audit, 2026-10-07)

Nothing here has been executed. Evidence: grep of this worktree plus read-only `ssh oracle` (docker ps, ls, crontab).

## Root cause

`DEFAULT_GYM_ID = 'psycle-london'` (`server/gyms.config.js:461`) was the WP-D2 migration anchor for single-tenant
users. It outlived the migration and now acts as a silent "guess Psycle" fallback inside a gym-agnostic core. The
"psycle" infra names are the same legacy: the app was once the Psycle companion backend, and the dirs, containers,
DB file and backup job kept the name. With no real users and a recreatable DB, both can go.

## Part A. DEFAULT_GYM_ID

### A1. Every non-test use (server/ 6 files, client/ 0)

| # | Where | Purpose | Needed now? | Replace with |
|---|-------|---------|-------------|--------------|
| 1 | `gyms.config.js:461,463` | Definition and export | No | Delete. Keep nothing exported. |
| 2 | `db.js:513,525` `backfillUserGyms()` | Boot migration: pre-D4 users (password_hash NULL) get a psycle link | No. DB recreated, no pre-D4 rows | Delete function and its boot call |
| 3 | `db.js:549` `backfillGymEmails()` | Fill NULL gym_email for psycle links | No | Delete with #2 |
| 4 | `db.js:779` `resolveActiveGymId(null)` | No user id yields default gym | Risky, see A3 | Return `null`; callers handle it |
| 5 | `db.js:846-847` `resolvePersistedGymId` | 0 links or many links w/o a pick falls to psycle, else `links[0]` | Wrong for gym-agnostic | 1 link: it. 0 links: `null`. Many: stored `active_gym_id` if linked, else first by `linked_at`/id (deterministic), never psycle-first |
| 6 | `db.js:1216` `createUser()` | Legacy "first gym login creates account + psycle link" | No. Signup + `POST /api/my-gyms/link` is the flow | Delete `createUser` default-link path, or make it take an explicit gymId |
| 7 | `auth.js:175` `handleLogin` | New account logging in via a gym form bootstraps against psycle | No (legacy path) | New email with no SA account: 401 "sign up first". Removes the hidden gym-login-as-signup path |
| 8 | `auth.js:58,61` dev mock login | `dev@psycle.com` mock is psycle | Dev only, but it is explicit intent | Pass `'psycle-london'` as a literal ONLY inside the mock block, or read from `mock.js` export (`MOCK_GYM_ID`). `test-no-gym-privilege.js` bans literals outside allowed files, so add `mock.js`/`auth.js` mock block to its allowlist |
| 9 | `scheduler.js:159` `getClassReleaseTime` | `row.gym_id || DEFAULT` for bare-string callers | No. `gym_id` is NOT NULL on every row | If no gym_id return `null` (already the "skip" contract); fix the bare-string test callers |
| 10 | `scheduler.js:774` | Comment only | n/a | Reword |
| 11 | `notifications.js:11` `zoneFor` | Zone for a null gym | No | Return null; callers skip or use `getGymConfig` of the row gym |
| 12 | `notifications.js:125` | Display config fallback | No | Neutral generic title via `config.appName` |
| 13 | `notifications.js:237-249` | Sample payloads for `/api/push/test/:type` | Debug only | Use first enabled gym: `listEnabledGyms()[0].id` |
| 14 | `dev-setup-jab.js:77-152` | CLI picks "the other gym" and prints a switch-back hint | Dev tool | Replace with `--gym` required arg, or switch-back = previously active gym id. Rename file to `dev-setup-gym.js` |
| 15 | `db.js:586,756,1858,2338` | Comments referencing it | n/a | Reword |

Client: zero uses of `DEFAULT_GYM_ID`. The literal `'psycle-london'` in client/src appears only in tests, fixtures,
comments (`url-state.js:158`, `cache.js:375`, `settings.js:1656`). Settings comment at 1656 says "server default is
psycle-london", which becomes false; fix the wording.

### A2. DDL defaults, ensureColumn, migration regexes (`db.js`)

| Line | What | Verdict |
|------|------|---------|
| 301 | Comment example id | Reword (use `gym-a`) |
| 432-447 | `GYM_DEFAULT_RE` + `dropGymIdDefault()` rebuild that strips `DEFAULT 'psycle-london'` from 8 tables | Dead on a fresh DB: new DDL has no default. Delete the whole WP-D6 block (`GYM_SCOPED_TABLES`, `dropGymIdDefault`, its call) |
| 591, 598 | `ensureColumn('auto_bookings'/'auto_upgrades','gym_id',"TEXT DEFAULT 'psycle-london'")` | Add `gym_id TEXT NOT NULL` into the two CREATE TABLE statements instead; delete both ensureColumns and `rebuildWithGymId` if only used here |
| 623, 638, 663, 685, 713 | `gym_id TEXT NOT NULL DEFAULT 'psycle-london'` in 5 CREATE TABLEs | Drop `DEFAULT ...`. This is the actual "refuse to guess" end state the file already claims |

Net: roughly 80-120 lines of migration code removed. All of it only matters for a DB created before 2026-09; recreating the DB makes it provably dead.
Constraint: this is only safe if prod and dev DBs are recreated (Part B step 3). If any old DB survives, `NOT NULL` without default on an old table fails at INSERT. Do A2 and the DB recreate in the same deploy.

### A3. Where removal could break a real flow

1. **Cron/background with no gym context.** `resolveActiveGymId(userId)` is called with no `AsyncLocalStorage`
   context by poller, scheduler, calendar (`runWithGymContext` wraps most). Rows carry `gym_id`, so scanners are fine
   (AGENTS.md rule: cross-user scanners must not filter by gym). Risk is a code path using `getUserById(...).jwt` for a
   user with 2+ links and no persisted `active_gym_id`: today lands on psycle, after change on a deterministic first link.
   Both are arbitrary, but behaviour is stable. Verify with `test-background-gym-session.js`.
2. **Null return type.** `resolveActiveGymId` returning `null` for 0 links must not reach `getGymConfig(null)` or SQL
   `gym_id = ?` (silently matches nothing: acceptable) or `NOT NULL` inserts (throws: acceptable, names itself). Audit the
   about 10 callers; the NO_GYM_LINKED 409 path (`routes-normalized.js:104-131`, `db.js:488`) already handles it for routes.
3. **Signup** (`createAccount`) is gym-less already, unaffected. **Legacy `handleLogin` bootstrap** (#7) is the one real
   behaviour change: a new email can no longer log in straight against a gym. Check `client` login form and onboarding
   do not rely on it (`api-no-gym.test.js`, `test-account-identity.js`).
4. **Admin routes:** `getAllUsers` already gym-aware (C3-7). `POST /api/admin/users/:id/link-gym` names its gym. Fine.
   Admin user detail for a 0-link user must tolerate null active gym (`test-admin-gym-aware.js`).
5. **Calendar:** fans out over `db.getUserGyms()`, no default. Low risk.
6. **Mocks/dev-setup:** `auth.js` mock login (#8) and `dev-setup-jab.js` (#14) are the two real consumers; both dev-only but
   `npm run dev` login for `dev@psycle.com` must keep working. Run the dev login manually after.
7. **test-no-gym-privilege.js** scans source for `psycle-london`/`jab-boxing` literals and tells you to "import
   DEFAULT_GYM_ID" (line 90). Update the message and allowlist when the export goes.

### A4. Tests that assert the old fallback (will change)

| Suite | Assertion that changes |
|-------|------------------------|
| `test-active-gym.js` (lines 62-63, 77, 91-123, 230) | `resolveActiveGymId(999999)` and `(null)` equal psycle; a gym-less/unlinked case falls to default. New: `null`; after `unlinkGym` also null |
| `test-admin-gym-aware.js` (50-57) | "two-gym account resolves to the default gym (psycle-london)". New: resolves per rule 5 (stored pick, else first link) |
| `test-background-gym-session.js` (33,45) | imports `DEFAULT_GYM_ID`, sanity-asserts active = default. Use explicit `PSYCLE` const and set `active_gym_id` |
| `test-poller-backoff.js` (28-41), `test-rate-limit-abort.js` (29-47) | import `DEFAULT_GYM_ID` to delete the auto-created default link in setup. Replace with explicit gym id; also the setup relies on `createUser()` creating the psycle link (#6) |
| `test-no-gym-privilege.js` (8,81-90) | Guard text and allowlist |
| `test-backfill-user-gyms.js` | Tests `backfillUserGyms`/`backfillGymEmails`: delete the suite |
| `test-gym-identity.js` | Check for backfillGymEmails cases (WP-D5): delete those cases |
| `test-no-active-gym.js`, `test-gym-required.js` | Likely extend: add 0-link null cases |
| `test-scheduler-event-details.js`, `test-wake-clock.js` | Check for bare-string `getClassReleaseTime` callers (#9) |
| `test-regression-psycle.js` | Does NOT use DEFAULT_GYM_ID. It sends `x-gym-id: psycle-london` explicitly in every authed call (lines 118, 315-356, 466), so it survives. It does assert psycle-london in `/api/gyms` and `clearedGyms` (374, 544): fine, the gym still exists. Only rename the file (`test-regression-psycle.js` to `test-regression-codexfit.js`, update `TESTING.md:44` and AGENTS.md) |

Many other suites use the literal `'psycle-london'` as a test fixture gym id; that is legitimate (a configured gym), leave it.

## Part B. Infra rename

### B1. Inventory (verified on oracle 2026-10-07)

| Thing | Current | Proposed |
|-------|---------|----------|
| Dockerfile `ENV DB_PATH` | `/data/psycle.db` | `/data/sweat.db` |
| Compose service | `psycle-app` | `sweat-app` |
| Container (prod / dev) | `psycle-app` / `psycle-app-dev` | `sweat-app` / `sweat-app-dev` |
| Compose dir (prod / dev) | `~/services/psycleapp` / `psycleapp-dev` | `~/services/sweatapp` / `sweatapp-dev` |
| Compose project -> image/network | `psycleapp(-dev)` -> `psycleapp-psycle-app`, `psycleapp_default` | auto: `sweatapp-sweat-app`, `sweatapp_default` |
| Named volume `psycle-data` | declared, UNUSED (data is bind `./data:/data`); an orphan `psycleapp-dev_psycle-data` exists | Delete declaration from compose; `docker volume rm` the orphan (empty) |
| DB file | `data/psycle.db` | `data/sweat.db` (or recreated) |
| `deploy.sh` | REMOTE_DIR x2, comments | `~/services/sweatapp[-dev]` |
| Backup script | `scripts/backup-sqlite.sh` installed as `/usr/local/sbin/psycle-backup-sqlite.sh`, SRC paths, `psycle-*.db.gz`, `ROOT=/var/backups/psycle-sqlite`, log `/var/log/psycle-backup-sqlite.log`, root cron 04:10 and 09:30 | `sweat-backup-sqlite.sh`, `/var/backups/sweat-sqlite`, `/var/log/sweat-backup-sqlite.log`, `sweat-*.db.gz`, Drive `Backups/sweat-sqlite/{prod,dev}` |
| Ingress | cloudflared -> `edge` network -> `psycle-app:3000` (compose comment, registry). Dev: tailnet `100.86.226.52:3005` | Upstream target must change to `sweat-app:3000`. UNVERIFIED where the tunnel route lives (remote-managed in Cloudflare dashboard vs local cloudflared config; `grep` of `~/services/cloudflared` found nothing). Check before step 6 |
| Cloudflare Access | apps `psycle`, `psycle-bypass` (hostnames psycle, sweat, sweat-dev; bypass `/api/calendar/*`, `/api/health`) | Leave names. Host `psycle.wingfield.tech` is a legacy alias: decide to drop (see decisions) |
| Registry / docs | `registry.md` rows 5-30 (history), 73-74, 159 (pi standby), 174-188 (network names); `oracle.md:110,216-226`; `pi.md:47`; `cloudflare.md` 37-38, 93-94, 141; memory `sqlite-backups-oracle.md` | Update same turn per registry rule |
| Pi standby | stopped `psycle-app`, `~/psycleapp` | Out of scope; delete or leave (it is a rollback relic of the pre-modular build). Do not rename |

Health checks: only URLs (`sweat(-dev).wingfield.tech/api/health`), no container-name dependence. The `--check-stale`
alert and `oracle-backup.sh` (03:30, snapshots `psycleapp` into `sqlite/`) hold paths: grep `/usr/local/sbin/oracle-backup.sh` for `psycleapp` and edit
(UNVERIFIED, not read).

### B2. Recommended path: recreate, do not copy

Because `data/` is a bind mount, there is no volume copy at all: a rename is `mv` of a directory. Since there are no
real users, recommend the simplest safe path: **take a final backup, create a fresh empty `data/`, let the new build
create `sweat.db`**. This also satisfies the Part A requirement (no old schema anywhere). Keep the old `data-*-archive`
dir for rollback; do not `docker volume prune`.

### B3. Ordered steps (dev twin first)

Code changes land first on a branch (A removal, Dockerfile, compose, deploy.sh, backup script), `npm test` green, merged to master.

Dev twin:
1. `ssh oracle 'sudo /usr/local/sbin/psycle-backup-sqlite.sh'`; verify dated `.db.gz` in `/var/backups/psycle-sqlite/dev` and on Drive.
2. `ssh oracle 'cd ~/services/psycleapp-dev && docker compose down'` (dev only; ~1 min dev outage).
3. `mv ~/services/psycleapp-dev ~/services/sweatapp-dev`; `mv data data-archive-<date>`; `mkdir data`; copy `.env` unchanged.
4. Local: `./deploy.sh --print` then `./deploy.sh` (rsync to new dir, `docker compose up -d --build`). Needs `.env` present in new dir.
5. Remove orphans: `docker volume rm psycleapp-dev_psycle-data`, `docker network rm psycleapp-dev_default` (verify unused first with `docker network inspect`).
6. Verify: `docker ps` shows `sweat-app-dev`, tailnet and `https://sweat-dev.wingfield.tech/api/health` = ok, browser smoke (CDP 9222): signup, link dev gym, timetable. Confirm Cloudflare route for dev still resolves (dev host is bind/tailnet fronted; check what upstream it uses).
7. Install new backup script: `sudo install ... /usr/local/sbin/sweat-backup-sqlite.sh`, new SRC paths, run once manually, check log and Drive `Backups/sweat-sqlite/dev`. Do NOT touch cron yet.

Prod (only after dev is green for a day):
8. Pre-deploy backup: `sudo /usr/local/sbin/psycle-backup-sqlite.sh` (or the new script), confirm dated artefact.
9. Temporary compat: in prod compose give the service `networks: edge: aliases: [psycle-app]` so the tunnel upstream keeps resolving across the rename. Removes the ordering race between container rename and tunnel edit.
10. `docker compose down`; `mv ~/services/psycleapp ~/services/sweatapp`; archive `data/` to `data-archive-<date>` and `mkdir data`; keep `.env` (ENCRYPTION_KEY unchanged is irrelevant for an empty DB but keep it).
11. `./deploy.sh --prod` (typed "deploy prod"). Verify `docker ps`, `https://sweat.wingfield.tech/api/health`, `docker exec sweat-app wget -qO- localhost:3000/api/gyms`.
12. Edit tunnel upstream to `sweat-app:3000` (Cloudflare dashboard or API: needs user go-ahead), re-probe, then drop the alias in compose and redeploy.
13. Cron: replace the two root crontab lines with `sweat-backup-sqlite.sh` paths (absolute, `>> /var/log/... 2>&1`). Wait for the next 04:10 run and check the artefact by date (rule 9). Then remove old script, old Drive folder `Backups/psycle-sqlite` only on explicit user say-so (rclone/Drive deletes are not reversible).
14. Edit `registry.md` (add rows, drop psycle rows, networks line), `oracle.md`, `cloudflare.md`, `pi.md`, memory file, append `Server Management/CHANGELOG.md`.
15. Docs in this repo: AGENTS.md, TESTING.md, deploy.sh comments, backup script header.

### B4. Downtime

Dev: about 1-2 min. Prod: about 2-4 min (down, mv, rebuild, up; image rebuild is the long pole, can pre-build). The
recreated prod DB means every account is gone: signup + gym relink required (accepted by the user).

### B5. Rollback

Dev/prod: `docker compose down`; `mv ~/services/sweatapp ~/services/psycleapp`; `rm -r data; mv data-archive-<date> data`
(DB file keeps its old name inside the archive, so set `DB_PATH=/data/psycle.db` in `.env` or checkout the previous commit and `./deploy.sh`); restore tunnel upstream to `psycle-app:3000`. Old
backups remain untouched in `/var/backups/psycle-sqlite` and Drive. Prior known-good code: current master before the merge.

### B6. Needs the user's typed confirmation / explicit go

- `./deploy.sh --prod` typed `deploy prod` (script-enforced).
- Prod `docker compose down` and DB archive+recreate (destroys all prod accounts).
- Any Cloudflare tunnel/Access edit (exposure-adjacent; rule 6).
- Deleting old Drive backups `Backups/psycle-sqlite`, orphan volumes, the stopped Pi `psycle-app`.
- Root crontab edits on oracle.

## Decisions needed

1. Recreate databases (clean `sweat.db`, drops all prod accounts) versus rename-in-place keeping `psycle.db` data (then A2 migrations must stay).
2. Retire the legacy hostname `psycle.wingfield.tech` (and Access apps named `psycle`) or keep as alias.
3. Keep `handleLogin` bootstrap (a gym login creates the account) or remove it so signup is the only account creation path.
