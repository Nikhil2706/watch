#!/usr/bin/env bash
#
# Weekly: refresh the oldest slice of the TMDB cache, then back the stack up to E:.
#
# Installed at /usr/local/bin/jellyfin-gate-weekly.sh, driven by
# /etc/cron.d/jellyfin-gate-weekly — the same shape as wsl-mem-reclaim.
#
# Self-guarding, for the same reason that script is: this host is an i3 with a
# failing boot SSD, and a maintenance job that fires during a transcode or a
# build is worse than one that skips a week. It checks before doing anything and
# exits quietly if the moment is wrong.
#
# NOTE ON TIME: this distro runs UTC while Windows runs IST (+5:30). The cron
# line is therefore written in UTC — 20:00 UTC is 01:30 IST, which is the point
# of it.

set -uo pipefail

REPO=/mnt/c/Users/Dell/Downloads/jellyfin-gate
LOG=/var/log/jellyfin-gate-weekly.log
BASE=https://watch.abhigyanverma.com

log() { echo "[$(date -Is)] $*" >> "$LOG"; }

log "=== weekly maintenance starting ==="

# --- guard: is the stack even up? -------------------------------------------
if ! docker ps --format '{{.Names}}' | grep -q '^jellyfin-gate$'; then
  log "gate is not running — skipping this week"
  exit 0
fi

# --- guard: is anyone watching? ---------------------------------------------
KEY=$(sed -n 's/^JELLYFIN_API_KEY=//p' "$REPO/.env" | tr -d '"\r')
PLAYING=$(docker exec jellyfin curl -sS --max-time 20 \
  "http://127.0.0.1:8096/Sessions?api_key=$KEY" 2>/dev/null \
  | grep -o '"NowPlayingItem"' | wc -l)
if [ "${PLAYING:-0}" -gt 0 ]; then
  log "someone is watching ($PLAYING stream(s)) — skipping this week"
  exit 0
fi

# --- guard: is the box busy? ------------------------------------------------
LOAD=$(cut -d' ' -f1 /proc/loadavg)
if [ "$(echo "$LOAD > 2.0" | bc -l 2>/dev/null || echo 0)" = "1" ]; then
  log "load average $LOAD is too high — skipping this week"
  exit 0
fi

# --- 1. refresh the oldest slice of the cache -------------------------------
#
# Deliberately a slice, not the whole store. TMDB imposes no daily quota, but
# this host's link to it drops roughly one request in thirty, so a full 390-film
# refresh in one go would spend a long time failing. Four passes of 60 covers
# about 240 entries a week, which turns the whole store over in under a fortnight.
ADMIN=$(sed -n 's/^ADMIN_API_KEY=//p' "$REPO/.env" | tr -d '"\r')
for i in 1 2 3 4; do
  R=$(curl -sS --max-time 280 -X POST "$BASE/api/admin/tmdb" \
      -H "x-admin-key: $ADMIN" -H 'Content-Type: application/json' \
      -d '{"mode":"refresh","maxAgeDays":7,"budget":60}' 2>/dev/null)
  log "refresh pass $i: $R"
  echo "$R" | grep -q '"refreshed":0' && break
  sleep 5
done

# --- 2. pick up anything new that arrived in the library --------------------
R=$(curl -sS --max-time 280 -X POST "$BASE/api/admin/tmdb" \
    -H "x-admin-key: $ADMIN" -H 'Content-Type: application/json' \
    -d '{"budget":60}' 2>/dev/null)
log "backfill new: $R"

# --- 3. episode stills for anything newly linked ----------------------------
R=$(curl -sS --max-time 280 -X POST "$BASE/api/admin/episode-stills" \
    -H "x-admin-key: $ADMIN" -H 'Content-Type: application/json' \
    -d '{"budget":100}' 2>/dev/null)
log "episode stills: $R"

# --- 4. back it all up to E: ------------------------------------------------
# Last, so the backup captures the state the refresh just produced.
if bash "$REPO/scripts/backup-to-e.sh" >> "$LOG" 2>&1; then
  log "backup ok"
else
  log "BACKUP FAILED — the drive on C: is failing, so this matters"
fi

log "=== weekly maintenance done ==="
