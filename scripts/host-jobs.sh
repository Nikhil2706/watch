#!/usr/bin/env bash
#
# Runs the scheduled jobs that have to happen on this computer rather than
# inside the site — today, the backup.
#
# The schedule lives in the site (console → Health → Scheduled jobs), where it
# can be seen, rescheduled, paused and run by hand. The site is in a container
# and cannot start a script out here, so this asks it, once a minute, what is
# due, runs that, and tells it how it went.
#
# Installed at /usr/local/bin/jellyfin-gate-host-jobs.sh, driven by
# /etc/cron.d/jellyfin-gate-host-jobs:
#
#   * * * * * root /usr/local/bin/jellyfin-gate-host-jobs.sh
#
# It replaces the cron lines that ran the backup at a fixed hour
# (/etc/cron.d/jellyfin-gate-backup) and the weekly TMDB refresh
# (/etc/cron.d/jellyfin-gate-weekly — that one is now a job the site runs
# itself). Remove both when installing this, or each will run twice.
#
# WHAT IT MAY RUN IS FIXED HERE. The site hands over a kind — one word — and
# the case statement below decides what that means. Nothing from the database
# is ever put on a command line, so a wrong row can at worst ask for a job
# that already exists.

set -uo pipefail

[ -r /etc/default/jellyfin-gate ] && . /etc/default/jellyfin-gate
REPO="${JFG_REPO:?set JFG_REPO in /etc/default/jellyfin-gate}"
GATE="${JFG_GATE_URL:-http://127.0.0.1:3000}"
LOG=/var/log/jellyfin-gate-host-jobs.log
HERE="$(dirname "$0")"

log() { echo "[$(date -Is)] $*" >> "$LOG"; }

# One at a time: a backup takes minutes and cron comes back every one.
exec 9>/run/lock/jellyfin-gate-host-jobs.lock
flock -n 9 || exit 0

ADMIN=$(sed -n 's/^ADMIN_API_KEY=//p' "$REPO/.env" | tr -d '"\r')
[ -n "$ADMIN" ] || exit 0

# Quiet when the site is down or nothing is due — which is nearly every minute.
DUE=$(curl -fsS --max-time 20 -H "x-admin-key: $ADMIN" "$GATE/api/admin/schedule/host" 2>/dev/null) || exit 0
[ -n "$DUE" ] || exit 0

report() { # run_id ok summary
  local summary
  summary=$(printf '%s' "$3" | tr -d '\000-\037' | sed 's/\\/\\\\/g; s/"/\\"/g' | cut -c1-600)
  curl -fsS --max-time 20 -X POST "$GATE/api/admin/schedule/host" \
    -H "x-admin-key: $ADMIN" -H 'Content-Type: application/json' \
    -d "{\"run_id\":\"$1\",\"ok\":\"$2\",\"summary\":\"$summary\"}" >/dev/null 2>&1 \
    || log "could not report run $1 to the site"
}

while read -r RUN_ID KIND FORCED; do
  [ -n "${RUN_ID:-}" ] || continue
  case "$KIND" in
    backup)
      log "backup starting (forced=$FORCED)"
      # The backup script decides for itself whether one is due and whether
      # someone is watching, and says which in its last line. "Run now" in
      # the console means now: JFG_FORCE skips both questions.
      OUT=$(JFG_FORCE="$FORCED" bash "$HERE/jellyfin-gate-backup.sh" 2>&1); CODE=$?
      LAST=$(printf '%s\n' "$OUT" | tail -1)
      if [ "$CODE" -eq 0 ]; then report "$RUN_ID" 1 "${LAST:-finished}"; else report "$RUN_ID" 0 "${LAST:-exit $CODE}"; fi
      log "backup finished: exit $CODE ${LAST:-}"
      ;;
    *)
      log "asked for a job this script does not run: $KIND"
      report "$RUN_ID" 0 "This computer's runner does not know the job '$KIND'."
      ;;
  esac
done <<< "$DUE"
