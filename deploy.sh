#!/usr/bin/env bash
#
# Sweat Assistant: deploy to the oracle VM (C7-8).
#
# Both environments live on `oracle`:
#
#   dev twin  ~/services/sweatassistant-dev/   compose: docker-compose.yml        sweat-dev.wingfield.tech  (default)
#   prod      ~/services/sweatassistant/       compose: docker-compose.prod.yml   sweat.wingfield.tech
#
# The flow is what was done by hand: rsync the tree, then
# `docker compose up -d --build` on the host. Nothing here writes .env or
# data/ (secrets and the SQLite database live only on the host).
#
# Prod is never the default. It needs --prod AND a typed confirmation, and it
# refuses to run without a terminal.
#
# Usage:
#   ./deploy.sh                 deploy to the dev twin
#   ./deploy.sh --print         show every command, run nothing (no ssh at all)
#   ./deploy.sh --prod          deploy to prod (asks you to type "deploy prod")
#
# Env: DEPLOY_HOST (default oracle), DEPLOY_DOCKER (default "docker"; set to
# "sudo docker" if the login user is not in the docker group).
set -euo pipefail

HOST="${DEPLOY_HOST:-oracle}"
DOCKER="${DEPLOY_DOCKER:-docker}"
TARGET=dev
PRINT=0

for arg in "$@"; do
  case "$arg" in
    --prod)  TARGET=prod ;;
    --dev)   TARGET=dev ;;
    --print) PRINT=1 ;;
    -h|--help) sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown argument: $arg (try --help)" >&2; exit 2 ;;
  esac
done

if [ "$TARGET" = prod ]; then
  REMOTE_DIR='~/services/sweatassistant'
  COMPOSE_FILE='docker-compose.prod.yml'
  HEALTH_URL='https://sweat.wingfield.tech/api/health'
else
  REMOTE_DIR='~/services/sweatassistant-dev'
  COMPOSE_FILE='docker-compose.yml'
  HEALTH_URL='https://sweat-dev.wingfield.tech/api/health'
fi

# Always excluded: secrets, the database volume, build output, dependencies, VCS.
EXCLUDES=(--exclude .env --exclude '.env.*' --exclude data/ --exclude node_modules/
          --exclude client/node_modules/ --exclude server/node_modules/
          --exclude client/dist/ --exclude server/public/ --exclude .git/
          --exclude .DS_Store --exclude '*.db' --exclude '*.db-shm' --exclude '*.db-wal')
# docker-compose.yml is the DEV twin's (container sweatassistant-dev, bound to the tailnet
# address); prod runs docker-compose.prod.yml (container sweatassistant, no published port).
# Each target ships only its own file so one can never overwrite the other.
if [ "$TARGET" = prod ]; then EXCLUDES+=(--exclude docker-compose.yml); else EXCLUDES+=(--exclude docker-compose.prod.yml); fi

RSYNC=(rsync -az "${EXCLUDES[@]}" ./ "$HOST:$REMOTE_DIR/")
REMOTE_UP="cd $REMOTE_DIR && $DOCKER compose -f $COMPOSE_FILE up -d --build && $DOCKER compose -f $COMPOSE_FILE ps"

run() { if [ "$PRINT" = 1 ]; then printf '  %q' "$@"; printf '\n'; else "$@"; fi; }

cd "$(dirname "$0")"
[ -f docker-compose.yml ] && [ -d server ] || { echo "Run from the App/ directory (docker-compose.yml + server/ not found)." >&2; exit 1; }

echo "=== Deploy target: $TARGET ($HOST:$REMOTE_DIR) ==="
[ "$PRINT" = 1 ] && echo "(--print: nothing will be executed)"

if [ "$TARGET" = prod ] && [ "$PRINT" = 0 ]; then
  if [ ! -t 0 ]; then echo "Refusing to deploy prod without an interactive terminal." >&2; exit 1; fi
  echo "This rebuilds the LIVE service at sweat.wingfield.tech."
  read -r -p 'Type "deploy prod" to continue: ' answer
  [ "$answer" = "deploy prod" ] || { echo "Aborted."; exit 1; }
fi

echo "[1/2] rsync"
run "${RSYNC[@]}"
echo "[2/2] docker compose up -d --build"
run ssh "$HOST" "$REMOTE_UP"

echo "Done. Verify:  curl -s $HEALTH_URL"
echo "Also check the registry (~/.claude/skills/selfhost-deploy/references/registry.md) if ports or names changed."
