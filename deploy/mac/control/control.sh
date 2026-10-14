#!/bin/bash
# control.sh <action> -- what the "Watch Control" desktop app runs.
#   status | disconnect [force] | start | deploy | rollback | schedule-show
# Everything that changes the site writes to ~/Library/Logs/watch-control.log.
export PATH="$HOME/.orbstack/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
DRIVE="${WATCH_DRIVE:-/Volumes/Elements}"
REPO="$HOME/watch"
HOLD="$HOME/.config/watch/hold"
LOG="$HOME/Library/Logs/watch-control.log"
mkdir -p "$(dirname "$HOLD")"
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"; }
notify() { osascript -e "display notification \"$2\" with title \"Watch\" subtitle \"$1\"" >/dev/null 2>&1; }
playing() { bash "$HOME/watch-ops/playing.sh" 2>/dev/null || echo 0; }
code() { curl -s -o /dev/null -w '%{http_code}' --max-time "${2:-5}" "$1"; }

case "${1:-status}" in
status)
  echo "Site on this Mac:   $(code http://127.0.0.1:3000/login)   (200 = up)"
  echo "Public address:     $(code https://watch.abhigyanverma.com/login 15)   (200 up, 530 tunnel off, 502 site down)"
  echo "People watching:    $(playing)"
  if [ -d "$DRIVE/Da Moveesh" ]; then
    echo "Film drive:         connected ($(system_profiler SPUSBHostDataType 2>/dev/null | grep -A8 'Elements' | grep -m1 'Link Speed' | sed 's/.*: //'))"
  else echo "Film drive:         NOT connected"; fi
  [ -f "$HOLD" ] && echo "Held down:          yes - the site stays off until the drive is plugged back in (or Start)"
  echo "Running version:    $(git -C "$REPO" log --oneline -1 2>/dev/null)"
  echo; echo "Off-hours schedule:"
  /usr/bin/python3 -c '
import json,os
try: c=json.load(open(os.path.expanduser("~/.config/watch/schedule.json")))
except Exception: c={}
if c.get("enabled"): print("  weekdays off %s, on %s; weekends off %s, on %s" % (c["weekday"]["off"],c["weekday"]["on"],c["weekend"]["off"],c["weekend"]["on"]))
else: print("  none (on all the time)")'
  pmset -g sched 2>/dev/null | grep -E "shutdown|wakepoweron|wakeorpoweron" | head -2 | sed "s/^ *\[[0-9]*\] */  next: /"
  ;;

disconnect)
  N=$(playing)
  if [ "$N" != "0" ] && [ "${2:-}" != "force" ]; then echo "BUSY $N"; exit 2; fi
  echo "held $(date '+%Y-%m-%d %H:%M:%S')" > "$HOLD"
  log "disconnect: stopping the site ($N watching)"
  (cd "$REPO" && docker compose stop) >> "$LOG" 2>&1
  for i in 1 2 3; do
    # Ejected counts as "away" now: the start-up guard only looks every two
    # minutes and a quick re-plug would otherwise never release the hold.
    if diskutil eject "$DRIVE" >> "$LOG" 2>&1; then echo away >> "$HOLD"; log "drive ejected"; echo "EJECTED"; exit 0; fi
    sleep 3
  done
  log "eject refused; in use by: $(lsof +D "$DRIVE" 2>/dev/null | awk 'NR>1{print $1}' | sort -u | tr '\n' ' ')"
  echo "NOT_EJECTED"; exit 1
  ;;

start)
  rm -f "$HOLD"
  [ -d "$DRIVE/Da Moveesh" ] || { echo "NO_DRIVE"; exit 1; }
  log "start: bringing the site up"
  orbctl start >/dev/null 2>&1
  # After an eject and re-plug OrbStack cannot see the drive until restarted.
  docker run --rm -v "$DRIVE/Da Moveesh":/m:ro alpine true >/dev/null 2>&1 || { log "restarting OrbStack to see the drive"; orbctl stop >> "$LOG" 2>&1; orbctl start >> "$LOG" 2>&1; }
  (cd "$REPO" && docker compose up -d --no-build) >> "$LOG" 2>&1
  docker start jellyfin-gate-console >> "$LOG" 2>&1
  for i in $(seq 1 40); do [ "$(code http://127.0.0.1:3000/login)" = 200 ] && { echo "UP"; exit 0; }; sleep 3; done
  echo "NOT_UP"; exit 1
  ;;

deploy)
  # Whatever is merged on GitHub's platform-additions, live. Waits while
  # anyone is watching (up to 3 hours), rolls itself back if the site does
  # not answer afterwards.
  exec 9>"${TMPDIR:-/tmp}/watch-deploy.lock"; flock -n 9 || { notify "Deploy" "A deploy is already running."; exit 1; }
  D="$HOME/Library/Logs/watch-deploy.log"; exec >> "$D" 2>&1
  echo; echo "=== deploy $(date '+%Y-%m-%d %H:%M:%S')"
  cd "$REPO" || exit 1
  git fetch -q origin || { notify "Deploy failed" "Could not reach GitHub."; exit 1; }
  CUR=$(git rev-parse --short HEAD); NEW=$(git rev-parse --short origin/platform-additions)
  if [ "$CUR" = "$NEW" ]; then notify "Nothing to deploy" "Already running $CUR, the latest merged code."; echo "nothing new"; exit 0; fi
  git checkout -q platform-additions && git merge -q --ff-only origin/platform-additions || { notify "Deploy failed" "The Mac's copy has local changes; see watch-deploy.log."; exit 1; }
  echo "from $CUR to $NEW"; git log --oneline "$CUR..$NEW"
  notify "Deploy started" "Checking and building $NEW. The site stays up meanwhile."
  bash "$HOME/watch-ops/check.sh" "$REPO" > /tmp/watch-check.out 2>&1; tail -12 /tmp/watch-check.out
  if ! grep -q "TSC OK" /tmp/watch-check.out || ! grep -q "^# fail 0" /tmp/watch-check.out; then
    git reset -q --hard "$CUR"
    notify "Deploy stopped" "Type-check or tests failed; nothing changed. See watch-deploy.log."; exit 1
  fi
  TS=$(date +%Y%m%d-%H%M%S)
  docker tag watch-gate:latest "watch-gate:pre-$TS"; docker tag watch-worker:latest "watch-worker:pre-$TS"
  echo "$TS" > "$HOME/.config/watch/last-deploy"
  docker compose build gate worker || { notify "Deploy failed" "Build failed; the site is unchanged."; exit 1; }
  for i in $(seq 1 180); do [ "$(playing)" = "0" ] && break; [ "$i" = 1 ] && notify "Deploy waiting" "Someone is watching; it will go live when they stop."; sleep 60; done
  mkdir -p "$HOME/deploy-snapshots"
  docker exec jellyfin-gate node -e "new (require('node:sqlite').DatabaseSync)('/app/data/jellyfin-gate.db').exec(\"VACUUM INTO '/tmp/pre-deploy.db'\")" && docker cp jellyfin-gate:/tmp/pre-deploy.db "$HOME/deploy-snapshots/gate-$TS.db" && docker exec jellyfin-gate rm -f /tmp/pre-deploy.db
  docker compose up -d --no-build --force-recreate gate worker
  ok=0; for i in $(seq 1 40); do [ "$(code http://127.0.0.1:3000/login)" = 200 ] && { ok=1; break; }; sleep 3; done
  # The console's page is a file mounted from the repo; a checkout replaces it,
  # so restart the console to pick up the new one.
  docker restart jellyfin-gate-console >/dev/null 2>&1
  if [ "$ok" = 1 ] && [ "$(docker inspect jellyfin-gate --format '{{.Image}}')" = "$(docker image inspect watch-gate:latest --format '{{.Id}}')" ]; then
    notify "Deployed $NEW" "The site is up on the new version."; echo "deployed $NEW"; exit 0
  fi
  echo "site did not come back - rolling back"; bash "$0" rollback; notify "Deploy rolled back" "The new version did not start; the previous one is back. See watch-deploy.log."; exit 1
  ;;

rollback)
  TS=$(cat "$HOME/.config/watch/last-deploy" 2>/dev/null) || { echo "NO_DEPLOY"; exit 1; }
  log "rollback to images pre-$TS"
  docker tag "watch-gate:pre-$TS" watch-gate:latest && docker tag "watch-worker:pre-$TS" watch-worker:latest || { echo "NO_IMAGES"; exit 1; }
  (cd "$REPO" && docker compose up -d --no-build --force-recreate gate worker) >> "$LOG" 2>&1
  for i in $(seq 1 40); do [ "$(code http://127.0.0.1:3000/login)" = 200 ] && { echo "UP pre-$TS"; exit 0; }; sleep 3; done
  echo "NOT_UP"; exit 1
  ;;
esac
