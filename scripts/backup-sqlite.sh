#!/bin/bash
# backup-sqlite.sh — C1-5: nightly consistent SQLite backups of the Sweat Assistant
# prod + dev databases, off-host to Google Drive. Runs on oracle, as root.
#
# Source of truth is this file in the app repo. Install (see also the bottom of this header):
#   scp scripts/backup-sqlite.sh oracle:/tmp/ && \
#   ssh oracle 'sudo install -m 755 -o root -g root /tmp/backup-sqlite.sh /usr/local/sbin/psycle-backup-sqlite.sh'
# Root crontab (host TZ is Europe/London; avoids Mon 12:00 release and oracle-backup.sh at 03:30):
#   10 4 * * * /usr/local/sbin/psycle-backup-sqlite.sh >> /var/log/psycle-backup-sqlite.log 2>&1
#   30 9 * * * /usr/local/sbin/psycle-backup-sqlite.sh --check-stale >> /var/log/psycle-backup-sqlite.log 2>&1
#
# Method: `sqlite3 .backup` (online backup API) — safe while the app runs, includes WAL
# content, never stops a container. The copy is then integrity_check'ed; anything but "ok"
# deletes the copy, alerts, and exits non-zero. NEVER copies .env / ENCRYPTION_KEY: the DB
# holds encrypted gym credentials, and key + ciphertext must not travel together.
#
# Destination: gdrive_pierswingfield:/Backups/psycle-sqlite/{prod,dev}/  (rclone COPY, not
# sync — deletes never propagate; remote pruned by age). Restore: see the header of
# Documentation/Workstreams/C1-critical-fixes.md (C1-5) or `--help`.
set -uo pipefail

NTFY_TOPIC="piers_server_backups"
export RCLONE_CONFIG="/root/.config/rclone/rclone.conf"
REMOTE_BASE="gdrive_pierswingfield:/Backups/psycle-sqlite"
ROOT="/var/backups/psycle-sqlite"
KEEP_LOCAL_DAYS=14
KEEP_REMOTE_DAYS=30
STALE_HOURS=30
STAMP_FILE="$ROOT/last-success"
declare -A SRC=( [prod]=/home/ubuntu/services/psycleapp/data/psycle.db
                 [dev]=/home/ubuntu/services/psycleapp-dev/data/psycle.db )

notify() {
  curl -s -H "Title: [oracle] Sweat SQLite backup: $1" -H "Priority: high" -H "Tags: warning,oracle" \
    -d "$2" "https://ntfy.sh/$NTFY_TOPIC" >/dev/null 2>&1 || true
}
log() { echo "$(date -Is) $*"; }

if [ "${1:-}" = "--help" ]; then sed -n 2,20p "$0"; exit 0; fi

mkdir -p "$ROOT"; chmod 700 "$ROOT"

if [ "${1:-}" = "--check-stale" ]; then
  if [ ! -f "$STAMP_FILE" ] || [ $(( $(date +%s) - $(stat -c %Y "$STAMP_FILE") )) -gt $(( STALE_HOURS * 3600 )) ]; then
    log "STALE: no successful backup in ${STALE_HOURS}h"
    notify "STALE" "No successful psycle SQLite backup in ${STALE_HOURS}h (stamp: $STAMP_FILE)"
    exit 1
  fi
  log "stale-check OK"; exit 0
fi

log "=== psycle sqlite backup start ==="
umask 077
DAY="$(date +%F)"; TS="$(date +%Y%m%d-%H%M%S)"
FAILED=()
fail() { FAILED+=("$1"); log "!! FAILED: $1"; }

for env in prod dev; do
  src="${SRC[$env]}"
  dir="$ROOT/$env"; mkdir -p "$dir"
  if [ ! -f "$src" ]; then fail "$env: source missing ($src)"; continue; fi
  tmp="$dir/.psycle-$TS.db"; out="$dir/psycle-$TS.db.gz"
  rm -f "$tmp"
  if ! sqlite3 "$src" ".timeout 10000" ".backup '$tmp'" 2>&1; then fail "$env: .backup"; rm -f "$tmp"; continue; fi
  ic="$(sqlite3 "$tmp" 'PRAGMA integrity_check;' 2>&1)"
  if [ "$ic" != "ok" ]; then fail "$env: integrity_check said: $ic"; rm -f "$tmp"; continue; fi
  log "$env: snapshot $(du -h "$tmp" | cut -f1), integrity_check=ok"
  if ! gzip -9 -c "$tmp" > "$out"; then fail "$env: gzip"; rm -f "$tmp" "$out"; continue; fi
  rm -f "$tmp"
  gzip -t "$out" || { fail "$env: gzip -t"; rm -f "$out"; continue; }
  log "$env: wrote $out ($(du -h "$out" | cut -f1))"
  find "$dir" -name 'psycle-*.db.gz' -mtime +$((KEEP_LOCAL_DAYS - 1)) -print -delete | sed "s/^/$env: pruned local /"
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
