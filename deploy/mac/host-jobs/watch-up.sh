#!/bin/bash
# Brings the site up once the film drive is there. Run every two minutes by
# the com.watch.up launchd agent.
#
# Docker restarts the containers by itself, but a container whose film folder
# is missing at that moment fails and is not tried again; and on a Mac the
# external drive often mounts after Docker has started. This closes that gap,
# and does nothing at all when everything is already running.
#
# It never starts the site while the drive is absent: Jellyfin looking at an
# empty folder would decide every film had been deleted.
DRIVE="${WATCH_DRIVE:-/Volumes/Elements}"
REPO="$HOME/watch"
LOG="$HOME/Library/Logs/watch-up.log"
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"; }

docker info >/dev/null 2>&1 || { log "docker is not running yet - waiting"; exit 0; }

# "Disconnect drive" in the Watch Control app leaves this file. The site then
# stays down while the drive is still mounted (the eject may take a moment,
# or be refused), and comes back on its own once the drive has been away
# and is plugged in again. "Start site" removes the file by hand.
HOLD="$HOME/.config/watch/hold"
if [ -f "$HOLD" ]; then
  if [ ! -d "$DRIVE/Da Moveesh" ]; then
    grep -q away "$HOLD" || { echo away >> "$HOLD"; log "held: drive is away"; }
    exit 0
  fi
  grep -q away "$HOLD" || exit 0
  rm -f "$HOLD"; log "held: drive is back - releasing"
fi

# The drive went away while the site was running (a loose cable, an eject).
# Stop Jellyfin and the two processes that write to the library before
# anything can scan an empty folder and drop every film, and with them the
# ids everything else is keyed on. (Jellyfin's own 12-hourly scan is switched
# off by the site at boot, and the site's scan checks for the drive; this is
# the belt to those braces.) The site
# comes back by the block below once the drive is there again.
if [ ! -d "$DRIVE/Da Moveesh" ]; then
  if docker ps --format '{{.Names}}' | grep -qx -e jellyfin -e jellyfin-gate -e jellyfin-gate-worker; then
    log "film drive is gone while the site is running - stopping it"
    (cd "$REPO" && docker compose stop) >> "$LOG" 2>&1
  else
    log "film drive not mounted at $DRIVE - waiting"
  fi
  exit 0
fi

RUNNING=$(docker ps --format '{{.Names}}')
if ! echo "$RUNNING" | grep -qx jellyfin-gate || ! echo "$RUNNING" | grep -qx jellyfin; then
  log "site not running - starting it"
  # After a drive is ejected and plugged back in, OrbStack keeps its old view
  # of /Volumes and refuses the mount ("read-only file system"; seen
  # 2026-10-14). A restart of OrbStack is what refreshes it.
  if ! docker run --rm -v "$DRIVE/Da Moveesh":/m:ro alpine true >/dev/null 2>&1; then
    log "docker cannot see the drive - restarting OrbStack"
    orbctl stop >> "$LOG" 2>&1; orbctl start >> "$LOG" 2>&1
  fi
  (cd "$REPO" && docker compose up -d --no-build) >> "$LOG" 2>&1
fi
echo "$RUNNING" | grep -qx jellyfin-gate-console || docker start jellyfin-gate-console >> "$LOG" 2>&1
exit 0
