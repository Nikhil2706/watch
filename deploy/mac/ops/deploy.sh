#!/bin/bash
# deploy.sh   -- promote the rehearsed :dev images to the live site. ONLY ON
# THE OWNER'S "deploy". It restarts the site, which cuts playback for under a
# minute, so it refuses while anyone is watching.
set -uo pipefail
DRIVE="${WATCH_DRIVE:-/Volumes/Elements}"
[ -d "$DRIVE/Da Moveesh" ] || { echo "film drive not mounted - abort"; exit 1; }
[ "$(bash "$(dirname "$0")/playing.sh")" = "0" ] || { echo "SOMEONE IS WATCHING - not deploying"; exit 1; }
docker ps --format '{{.Names}}' | grep -qx jellyfin || { echo "jellyfin not running - abort"; exit 1; }
cd "$HOME/watch"; mkdir -p "$HOME/deploy-snapshots"
TS=$(date +%Y%m%d-%H%M%S)
echo "=== snapshot"
docker exec jellyfin-gate node -e "new (require('node:sqlite').DatabaseSync)('/app/data/jellyfin-gate.db').exec(\"VACUUM INTO '/tmp/pre-deploy.db'\")" || { echo "SNAPSHOT FAILED"; exit 1; }
docker cp jellyfin-gate:/tmp/pre-deploy.db "$HOME/deploy-snapshots/gate-$TS.db" && docker exec jellyfin-gate rm -f /tmp/pre-deploy.db && ls -la "$HOME/deploy-snapshots/gate-$TS.db"
echo "=== images: keep the current ones as :pre-$TS, promote :dev"
docker tag watch-gate:latest watch-gate:pre-$TS && docker tag watch-worker:latest watch-worker:pre-$TS
docker tag watch-gate:dev watch-gate:latest && docker tag watch-worker:dev watch-worker:latest
echo "=== restart"
docker compose up -d --no-build --force-recreate gate worker 2>&1 | grep -E 'Started|Recreated|Error|error'
for i in $(seq 1 40); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:3000/login || true)
  [ "$code" = "200" ] && break; sleep 3
done
echo "gate /login: $code"
docker exec jellyfin-gate node -e 'console.log("schema", new (require("node:sqlite").DatabaseSync)("/app/data/jellyfin-gate.db",{readOnly:true}).prepare("PRAGMA user_version").get().user_version)'
# compose has been seen to leave a container on the old image while reporting success
for c in jellyfin-gate jellyfin-gate-worker; do echo "$c runs $(docker inspect $c --format '{{.Image}}' | cut -c8-19)"; done
docker images --format '{{.Repository}}:{{.Tag}} {{.ID}}' | grep -E 'watch-(gate|worker):latest'
docker logs --since 2m jellyfin-gate 2>&1 | grep -iE "error|fail" | tail -3
echo "=== stop the test copy"; (cd "$HOME/dev-stack" 2>/dev/null && COMPOSE_FILE=docker-compose.yml docker compose --env-file "$HOME/watch/.env" stop 2>&1 | tail -2)
echo "rollback: docker tag watch-gate:pre-$TS watch-gate:latest; docker tag watch-worker:pre-$TS watch-worker:latest; docker compose up -d --no-build --force-recreate gate worker"
