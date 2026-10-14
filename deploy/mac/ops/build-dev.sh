#!/bin/bash
# build-dev.sh <worktree>   -- build watch-gate:dev / watch-worker:dev from a
# worktree and start the test copy on 127.0.0.1:3100 (its own database, the
# real Jellyfin, the film folder read-only). Needs ~/dev-stack set up from
# the package's payload/dev-stack (done 2026-10-14: ~/dev-stack, its own database
# copied from production that day).
set -uo pipefail
SRC="${1:?which worktree}"
[ "$(bash "$(dirname "$0")/playing.sh")" = "0" ] || { echo "SOMEONE IS WATCHING - not building"; exit 1; }
cd "$SRC" && git log --oneline -1
docker build -q --target runtime -t watch-gate:dev . || { echo "GATE BUILD FAILED"; exit 1; }
docker build -q --target worker -t watch-worker:dev . || { echo "WORKER BUILD FAILED"; exit 1; }
cd "$HOME/dev-stack" && COMPOSE_FILE=docker-compose.yml docker compose --env-file "$HOME/watch/.env" up -d --force-recreate 2>&1 | grep -E 'Started|Recreated|Error' || true
for i in $(seq 1 40); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:3100/login || true)
  [ "$code" = "200" ] && break; sleep 2
done
echo "dev /login: $code"
docker logs jellyfin-gate-dev 2>&1 | grep '\[boot\]' | tail -6
