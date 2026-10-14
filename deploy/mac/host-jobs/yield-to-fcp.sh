#!/bin/bash
# Freezes the worker (conversions, download preparation, the damaged-file
# check, the upload scan) while Final Cut Pro is open, and lets it carry on
# when Final Cut quits. Run every 15 s by the com.watch.yield launchd agent.
# Streaming is not frozen: Jellyfin and the site are untouched. The worker
# already pauses its own conversions while someone is watching.
LOG="$HOME/Library/Logs/watch-yield.log"
FLAG="$HOME/.config/watch/paused-for-fcp"
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"; }
docker info >/dev/null 2>&1 || exit 0
state=$(docker inspect jellyfin-gate-worker --format '{{.State.Status}}' 2>/dev/null) || exit 0
if pgrep -xq "Final Cut Pro"; then
  if [ "$state" = "running" ]; then
    docker pause jellyfin-gate-worker >/dev/null 2>&1 && touch "$FLAG" && log "Final Cut Pro is open - worker paused"
  fi
elif [ -f "$FLAG" ]; then
  # Only undo our own pause; a pause someone made by hand is left alone.
  [ "$state" = "paused" ] && docker unpause jellyfin-gate-worker >/dev/null 2>&1 && log "Final Cut Pro closed - worker resumed"
  rm -f "$FLAG"
fi
exit 0
