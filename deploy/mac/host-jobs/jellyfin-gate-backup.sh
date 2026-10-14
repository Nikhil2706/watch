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

# Host-specific paths live in $HOME/.config/watch/jellyfin-gate, so this file is the
# same on every machine; each restore used to mean hand-editing it. Unset is an
# error rather than a guess: a backup written to the wrong disk is the failure
# this job exists to prevent. See HOST-SETUP.md for the file's contents.
[ -r $HOME/.config/watch/jellyfin-gate ] && . $HOME/.config/watch/jellyfin-gate
REPO="${JFG_REPO:?set JFG_REPO in $HOME/.config/watch/jellyfin-gate}"
DEST_ROOT="${JFG_BACKUP_ROOT:?set JFG_BACKUP_ROOT in $HOME/.config/watch/jellyfin-gate}"
LOG="$HOME/Library/Logs/jellyfin-gate-backup.log"
MAX_AGE_DAYS=7

log() { echo "[$(date -Is)] $*" >> "$LOG"; }
# The last line this prints is what the console's job history shows.
say() { log "$*"; echo "$*"; }
# Set by scripts/host-jobs.sh when the curator pressed "Run now": take a
# backup regardless of how recent the last one is or who is watching.
FORCE="${JFG_FORCE:-0}"

# --- the drive, through a container ------------------------------------------
# macOS does not let a launchd job's own programs read or write an external
# drive (first run here, 2026-10-14: gzip and the shell were refused, and the
# "newest backup" listing came back empty). Docker already has that access,
# so everything this job does ON THE DRIVE happens inside a small container
# with the backup folder mounted at /b. Checking that the folder exists is
# allowed, and matters: Docker would create a missing folder on the Mac's own
# disk and the backup would land there.
[ -d "$DEST_ROOT" ] || { say "The backup drive is not connected ($DEST_ROOT) - will retry at the next scheduled time."; exit 1; }
ondrive() { docker run --rm -i -v "$DEST_ROOT":/b alpine sh -c "$1"; }

# --- is one actually due? ---------------------------------------------------
INFO=$(ondrive 'n=$(ls -1d /b/20* 2>/dev/null | sort | tail -1); [ -n "$n" ] && [ -f "$n/MANIFEST.txt" ] && echo "$(basename "$n") $(stat -c %Y "$n/MANIFEST.txt")"' 2>> "$LOG")
read -r NEWEST NEWEST_MTIME <<< "$INFO"
if [ -n "${NEWEST_MTIME:-}" ]; then
  AGE_DAYS=$(( ( $(date +%s) - NEWEST_MTIME ) / 86400 ))
  if [ "$AGE_DAYS" -lt "$MAX_AGE_DAYS" ] && [ "$FORCE" != "1" ]; then
    # Quiet in the log on purpose: this is the ordinary outcome six days in
    # seven, and a log line a day about nothing happening is how a log stops
    # being read.
    echo "Not due: the newest backup is $AGE_DAYS day(s) old."
    exit 0
  fi
  log "newest backup ($NEWEST) is $AGE_DAYS days old — one is due"
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
  say "The site is not running — will retry at the next scheduled time."
  exit 0
fi

KEY=$(sed -n 's/^JELLYFIN_API_KEY=//p' "$REPO/.env" | tr -d '"\r')
PLAYING=$(docker exec jellyfin curl -sS --max-time 20 \
  "http://127.0.0.1:8096/Sessions?api_key=$KEY" 2>/dev/null \
  | grep -o '"NowPlayingItem"' | wc -l)

if [ "${PLAYING:-0}" -gt 0 ] && [ "$FORCE" != "1" ]; then
  say "Someone is watching ($PLAYING stream(s)) — will retry at the next scheduled time."
  exit 0
fi

# --- once it is more than a fortnight late, stop being polite ---------------
if [ -n "${AGE_DAYS:-}" ] && [ "$AGE_DAYS" -ge 14 ]; then
  log "WARNING: last backup is $AGE_DAYS days old — running regardless of anything else"
fi

log "starting backup"
# Its sibling, wherever this copy lives (scripts/ in the repo, /usr/local/bin
# once installed).
if bash "$(dirname "$0")/backup-to-e.sh" >> "$LOG" 2>&1; then
  # --- keep only the newest backup ------------------------------------------
  # The curator's choice (2026-10-13): each one is about 2 GB and nothing ever
  # removed them. The older ones go only once the new one has been read back
  # from the disk, start to finish: a backup that cannot be read is no reason
  # to delete the one before it. Only folders named as a date are touched.
  RESULT=$(ondrive '
    L=$(ls -1d /b/20* 2>/dev/null | sort | tail -1)
    if [ -z "$L" ] || [ ! -f "$L/MANIFEST.txt" ] || ! gzip -t "$L/gate-data.db.gz" || ! tar -tzf "$L/jellyfin-config.tar.gz" > /dev/null; then
      echo UNREADABLE; exit 0
    fi
    n=0
    for o in $(ls -1d /b/20* | sort | sed "\$d"); do
      case "$(basename "$o")" in
        20[0-9][0-9]-[0-9][0-9]-[0-9][0-9]) rm -rf -- "$o" && echo "removed older backup $o" >&2 && n=$((n + 1)) ;;
      esac
    done
    echo "OK $n"' 2>> "$LOG")
  case "$RESULT" in
    "OK "*) say "Backup taken and read back. ${RESULT#OK } older one(s) removed." ;;
    *)      say "Backup taken, but it could not be read back, so the older ones are kept. See $LOG." ;;
  esac
else
  say "BACKUP FAILED. See $LOG."
  exit 1
fi
