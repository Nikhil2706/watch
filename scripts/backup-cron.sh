#!/usr/bin/env bash
#
# The backup, on its own schedule.
#
# It was a step inside weekly-maintenance.sh, and that was wrong. That script
# guards hard — it skips the whole run if anyone is watching or the load is high
# — which is right for a TMDB refresh that can wait a week, and wrong for a
# backup. Someone watching a film on three consecutive Sunday nights would have
# silently gone a month without one, on a machine whose boot disk is failing.
#
# So: this runs DAILY, and decides for itself whether a backup is actually due.
# A skipped night is picked up the next night instead of lost for a week.
#
# Installed at /usr/local/bin/jellyfin-gate-backup.sh, driven by
# /etc/cron.d/jellyfin-gate-backup.
#
# TIME IS UTC here; Windows is IST (+5:30).

set -uo pipefail

REPO=/mnt/c/Users/Dell/Downloads/jellyfin-gate
DEST_ROOT=/mnt/e/jellyfin-gate-backups
LOG=/var/log/jellyfin-gate-backup.log
MAX_AGE_DAYS=7

log() { echo "[$(date -Is)] $*" >> "$LOG"; }

# --- is one actually due? ---------------------------------------------------
NEWEST=$(ls -1d "$DEST_ROOT"/20* 2>/dev/null | sort | tail -1)
if [ -n "$NEWEST" ] && [ -f "$NEWEST/MANIFEST.txt" ]; then
  AGE_DAYS=$(( ( $(date +%s) - $(stat -c %Y "$NEWEST/MANIFEST.txt") ) / 86400 ))
  if [ "$AGE_DAYS" -lt "$MAX_AGE_DAYS" ]; then
    # Quiet on purpose: this is the ordinary outcome six days in seven, and a
    # log line a day about nothing happening is how a log stops being read.
    exit 0
  fi
  log "newest backup is $AGE_DAYS days old — one is due"
else
  log "no complete backup found — taking one"
fi

# --- guards, deliberately lighter than the weekly job's ---------------------
#
# Only playback is checked, because tarring 1.4 GB is real disk work and a
# transcode on this box is already close to the edge. Load is NOT checked: a
# backup that keeps deferring itself because the machine is mildly busy is a
# backup that never happens, which is the failure this file exists to prevent.
if ! docker ps --format '{{.Names}}' | grep -q '^jellyfin-gate$'; then
  log "gate is not running — will retry tomorrow"
  exit 0
fi

KEY=$(sed -n 's/^JELLYFIN_API_KEY=//p' "$REPO/.env" | tr -d '"\r')
PLAYING=$(docker exec jellyfin curl -sS --max-time 20 \
  "http://127.0.0.1:8096/Sessions?api_key=$KEY" 2>/dev/null \
  | grep -o '"NowPlayingItem"' | wc -l)

if [ "${PLAYING:-0}" -gt 0 ]; then
  log "someone is watching ($PLAYING stream(s)) — will retry tomorrow"
  exit 0
fi

# --- once it is more than a fortnight late, stop being polite ---------------
if [ -n "${AGE_DAYS:-}" ] && [ "$AGE_DAYS" -ge 14 ]; then
  log "WARNING: last backup is $AGE_DAYS days old — running regardless of anything else"
fi

log "starting backup"
if bash "$REPO/scripts/backup-to-e.sh" >> "$LOG" 2>&1; then
  log "BACKUP OK"
else
  log "BACKUP FAILED — the boot disk is failing, so this needs a look"
fi
