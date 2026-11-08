#!/bin/bash
# backup-sqlite.sh — C1-5: nightly consistent SQLite backups of the Dibs
# prod + dev databases, off-host to Google Drive. Runs on oracle, as root.
#
# Source of truth is this file in the app repo. Install (see also the bottom of this header):
#   scp scripts/backup-sqlite.sh oracle:/tmp/ && \
#   ssh oracle 'sudo install -m 755 -o root -g root /tmp/backup-sqlite.sh /usr/local/sbin/sweatassistant-backup-sqlite.sh'
# Root crontab (host TZ is Europe/London; avoids Mon 12:00 release and oracle-backup.sh at 03:30):
#   10 4 * * * /usr/local/sbin/sweatassistant-backup-sqlite.sh >> /var/log/sweatassistant-backup-sqlite.log 2>&1
#   30 9 * * * /usr/local/sbin/sweatassistant-backup-sqlite.sh --check-stale >> /var/log/sweatassistant-backup-sqlite.log 2>&1
#
# Method: `sqlite3 .backup` (online backup API) — safe while the app runs, includes WAL
# content, never stops a container. The copy is then integrity_check'ed; anything but "ok"
# deletes the copy, alerts, and exits non-zero. NEVER copies .env / ENCRYPTION_KEY: the DB
# holds encrypted gym credentials, and key + ciphertext must not travel together.
#
# ENCRYPTION (2026-11-06, owner's choice): uploads go to the rclone CRYPT remote gdrive_crypt:
# (Drive folder Backups/oracle-crypt, the same remote oracle-backup.sh uses), so Drive only ever
# holds ciphertext. Override with BACKUP_REMOTE_BASE. A non-crypt remote with no age recipient
# warns loudly (log + ntfy) on every run. age (below) is an optional extra layer.
# ENCRYPTION, optional age layer (security audit part 2). The DB holds gym session tokens and (unless JWT_SECRET is
# set in the environment) server_kv.jwt_secret, and the backup goes OFF-HOST to Google Drive. So
# each backup can be encrypted with `age` to a PUBLIC key; only the offline private key can read it.
# Configure with ONE of (env, or a root-only file /etc/sweatassistant-backup.env sourced below):
#   BACKUP_AGE_RECIPIENT="age1..."            # the public key itself
#   BACKUP_AGE_RECIPIENT_FILE=/root/.config/sweatassistant-backup/recipients.txt   # age recipients file
# Output is then sweatassistant-<ts>.db.gz.age (gzip, then age). With neither set the old behaviour
# is kept (plain .db.gz) and a LOUD warning is logged and sent to ntfy on every run.
#
# ONE-TIME OWNER STEPS ON ORACLE (this script does none of them):
#   1. sudo apt-get install -y age                     (or download the release binary for linux-arm64)
#   2. On a trusted machine (NOT oracle): age-keygen -o dibs-backup.key   -> prints "Public key: age1..."
#      Store dibs-backup.key OFFLINE (password manager / encrypted USB). Without it backups are unreadable.
#   3. On oracle: echo 'BACKUP_AGE_RECIPIENT=age1...' | sudo tee /etc/sweatassistant-backup.env
#      && sudo chmod 600 /etc/sweatassistant-backup.env   (public key only; no secret lives on oracle)
#   4. Re-install this script (see Install above), run it once by hand, confirm a *.db.gz.age lands in Drive.
#   5. Test a restore from a copy: age -d -i dibs-backup.key x.db.gz.age | gunzip > restored.db
#   6. Remove the old unencrypted *.db.gz from Drive (they hold the old secrets) and set JWT_SECRET in the
#      prod .env (openssl rand -hex 32) so the signing secret is not in the DB at all (changing it logs everyone out once).
# Restore of an encrypted backup: age -d -i <private key> FILE.db.gz.age | gunzip > app.db
#
# Destination: gdrive_crypt:/sweatassistant-sqlite/{prod,dev}/ (encrypted; was the plaintext gdrive_pierswingfield:/Backups/sweatassistant-sqlite until 2026-11-06). rclone COPY, not
# sync — deletes never propagate; remote pruned by age). Restore: see the header of
# Documentation/Workstreams/C1-critical-fixes.md (C1-5) or `--help`.
set -uo pipefail

NTFY_TOPIC="piers_server_backups"
export RCLONE_CONFIG="/root/.config/rclone/rclone.conf"
REMOTE_BASE="${BACKUP_REMOTE_BASE:-gdrive_crypt:/sweatassistant-sqlite}"   # rclone CRYPT remote (same as oracle-backup.sh, 2026-11-06)
ROOT="/var/backups/sweatassistant-sqlite"
KEEP_LOCAL_DAYS=14
KEEP_REMOTE_DAYS=30
STALE_HOURS=30
STAMP_FILE="$ROOT/last-success"
declare -A SRC=( [prod]=/home/ubuntu/services/sweatassistant/data/app.db
                 [dev]=/home/ubuntu/services/sweatassistant-dev/data/app.db )

notify() {
  curl -s -H "Title: [oracle] Sweat SQLite backup: $1" -H "Priority: high" -H "Tags: warning,oracle" \
    -d "$2" "https://ntfy.sh/$NTFY_TOPIC" >/dev/null 2>&1 || true
}
log() { echo "$(date -Is) $*"; }

if [ "${1:-}" = "--help" ]; then sed -n 2,50p "$0"; exit 0; fi

mkdir -p "$ROOT"; chmod 700 "$ROOT"

if [ "${1:-}" = "--check-stale" ]; then
  if [ ! -f "$STAMP_FILE" ] || [ $(( $(date +%s) - $(stat -c %Y "$STAMP_FILE") )) -gt $(( STALE_HOURS * 3600 )) ]; then
    log "STALE: no successful backup in ${STALE_HOURS}h"
    notify "STALE" "No successful SQLite backup in ${STALE_HOURS}h (stamp: $STAMP_FILE)"
    exit 1
  fi
  log "stale-check OK"; exit 0
fi

log "=== sweatassistant sqlite backup start ==="
umask 077
[ -f /etc/sweatassistant-backup.env ] && . /etc/sweatassistant-backup.env
AGE_ARGS=()
if [ -n "${BACKUP_AGE_RECIPIENT:-}" ]; then AGE_ARGS=(-r "$BACKUP_AGE_RECIPIENT")
elif [ -n "${BACKUP_AGE_RECIPIENT_FILE:-}" ]; then AGE_ARGS=(-R "$BACKUP_AGE_RECIPIENT_FILE"); fi
ENCRYPT=0
if [ ${#AGE_ARGS[@]} -gt 0 ]; then
  if command -v age >/dev/null 2>&1; then ENCRYPT=1
  else
    log "!! WARNING: a backup recipient is configured but 'age' is not installed - backups will be UNENCRYPTED"
    notify "UNENCRYPTED" "age is not installed; backup recipient configured but ignored"
  fi
elif rclone listremotes --long 2>/dev/null | grep -qE "^${REMOTE_BASE%%:*}:[[:space:]]+crypt\b"; then
  log "encryption: rclone crypt remote ${REMOTE_BASE%%:*}: (no age recipient set; age is optional on top)"
else
  log "!! WARNING: no BACKUP_AGE_RECIPIENT(_FILE) set and $REMOTE_BASE is not a crypt remote - this backup is UNENCRYPTED and is being copied off-host to Google Drive"
  notify "UNENCRYPTED" "SQLite backups go to Drive unencrypted: set a crypt BACKUP_REMOTE_BASE or an age recipient (see script header)"
fi
DAY="$(date +%F)"; TS="$(date +%Y%m%d-%H%M%S)"
FAILED=()
fail() { FAILED+=("$1"); log "!! FAILED: $1"; }

for env in prod dev; do
  src="${SRC[$env]}"
  dir="$ROOT/$env"; mkdir -p "$dir"
  if [ ! -f "$src" ]; then fail "$env: source missing ($src)"; continue; fi
  tmp="$dir/.sweatassistant-$TS.db"; out="$dir/sweatassistant-$TS.db.gz"
  rm -f "$tmp"
  if ! sqlite3 "$src" ".timeout 10000" ".backup '$tmp'" 2>&1; then fail "$env: .backup"; rm -f "$tmp"; continue; fi
  ic="$(sqlite3 "$tmp" 'PRAGMA integrity_check;' 2>&1)"
  if [ "$ic" != "ok" ]; then fail "$env: integrity_check said: $ic"; rm -f "$tmp"; continue; fi
  log "$env: snapshot $(du -h "$tmp" | cut -f1), integrity_check=ok"
  if ! gzip -9 -c "$tmp" > "$out"; then fail "$env: gzip"; rm -f "$tmp" "$out"; continue; fi
  rm -f "$tmp"
  gzip -t "$out" || { fail "$env: gzip -t"; rm -f "$out"; continue; }
  if [ "$ENCRYPT" = 1 ]; then
    # The plaintext gzip never leaves this host: encrypt, verify the .age parses, then delete it.
    if ! age "${AGE_ARGS[@]}" -o "$out.age" "$out"; then fail "$env: age encrypt"; rm -f "$out" "$out.age"; continue; fi
    rm -f "$out"; out="$out.age"
    [ -s "$out" ] || { fail "$env: encrypted file empty"; rm -f "$out"; continue; }
  fi
  log "$env: wrote $out ($(du -h "$out" | cut -f1))$([ "$ENCRYPT" = 1 ] && echo ' [age-encrypted]' || echo ' [no age layer]')"
  find "$dir" \( -name 'sweatassistant-*.db.gz' -o -name 'sweatassistant-*.db.gz.age' \) -mtime +$((KEEP_LOCAL_DAYS - 1)) -print -delete | sed "s/^/$env: pruned local /"
  if rclone copy "$out" "$REMOTE_BASE/$env/" --stats-one-line 2>&1; then
    log "$env: uploaded to $REMOTE_BASE/$env/"
    rclone delete "$REMOTE_BASE/$env/" --min-age "${KEEP_REMOTE_DAYS}d" -v 2>&1 | sed "s/^/$env: remote prune: /"
  else
    fail "$env: rclone copy"
  fi
done

if [ ${#FAILED[@]} -eq 0 ]; then
  touch "$STAMP_FILE"; log "=== OK ==="; exit 0
fi
log "=== FAILED: ${FAILED[*]} ==="
notify "FAILED" "${FAILED[*]}"
exit 1
