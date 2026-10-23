#!/usr/bin/env bash
#
# Landing site: deploy to the oracle VM (workstream M, decision M-D2).
#
#   ~/services/landing/   compose: landing/docker-compose.yml   $LANDING_HOST
#
# MANUAL STEP (not done by this script): add a Cloudflare tunnel ingress rule for
# $LANDING_HOST -> http://landing:80 (and DNS if not covered by the wildcard).
# Host confirmed: frontrow.wingfield.tech.
#
# Like `deploy.sh --prod` it asks for a typed confirmation and refuses to run
# without a terminal. Nothing is executed with --print (no ssh at all).
#
# Usage:
#   ./deploy-landing.sh --print    show every command, run nothing
#   ./deploy-landing.sh            deploy (asks you to type "deploy landing")
#
# Env: DEPLOY_HOST (default oracle), DEPLOY_DOCKER (default "docker").
set -euo pipefail

LANDING_HOST="${LANDING_HOST:-frontrow.wingfield.tech}"   # confirmed hostname
HOST="${DEPLOY_HOST:-oracle}"
DOCKER="${DEPLOY_DOCKER:-docker}"
REMOTE_DIR='~/services/landing'
PRINT=0

for arg in "$@"; do
  case "$arg" in
    --print) PRINT=1 ;;
    -h|--help) sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown argument: $arg (try --help)" >&2; exit 2 ;;
  esac
done

cd "$(dirname "$0")"
[ -f landing/docker-compose.yml ] && [ -f landing/index.html ] || { echo "landing/ not found." >&2; exit 1; }

RSYNC=(rsync -az --delete --exclude .DS_Store --exclude sync-gyms.sh --exclude .gitignore landing/ "$HOST:$REMOTE_DIR/")
REMOTE_UP="mkdir -p $REMOTE_DIR && cd $REMOTE_DIR && $DOCKER compose up -d --build && $DOCKER compose ps"

run() { if [ "$PRINT" = 1 ]; then printf '  %q' "$@"; printf '\n'; else "$@"; fi; }

echo "=== Deploy target: landing ($HOST:$REMOTE_DIR) for $LANDING_HOST ==="
[ "$PRINT" = 1 ] && echo "(--print: nothing will be executed)"

if [ "$PRINT" = 0 ]; then
  if [ ! -t 0 ]; then echo "Refusing to deploy without an interactive terminal." >&2; exit 1; fi
  echo "This rebuilds the landing container on $HOST."
  read -r -p 'Type "deploy landing" to continue: ' answer
  [ "$answer" = "deploy landing" ] || { echo "Aborted."; exit 1; }
fi

# Gym logos have ONE source of truth: client/public/gyms. landing/gyms is a generated copy
# (git-ignored), refreshed here and by hand for local viewing. This is a local copy, no ssh.
echo "[0/2] sync gym logos from client/public/gyms"
bash landing/sync-gyms.sh

echo "[1/2] rsync"
run ssh "$HOST" "mkdir -p $REMOTE_DIR"
run "${RSYNC[@]}"
echo "[2/2] docker compose up -d --build"
run ssh "$HOST" "$REMOTE_UP"

echo "Done. Verify:  curl -sI https://$LANDING_HOST/"
echo "MANUAL: Cloudflare tunnel ingress for $LANDING_HOST -> http://landing:80 must exist."
echo "Also update the selfhost-deploy registry (container 'landing', network edge, no published port)."
