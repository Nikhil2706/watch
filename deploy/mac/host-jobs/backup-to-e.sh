#!/usr/bin/env bash
#
# RETIRED 2026-10-14, not installed: the backup is a job the worker runs
# (scripts/backup.mjs), on the schedule in the console's Health tab. Kept as
# the working example of the site's "host" runner.
#
# Back the stack up to the external drive, a different physical disk from the
# Mac's own. (It was written for the old PC's E: drive, hence the name.)
#
# What it captures, and why each one:
#
#   gate-data      the gate's SQLite database — sessions, curation, invites,
#                  screenings, accolades, AND the TMDB cache. There is no
#                  separate "cache backup" to make: tmdb_cache is a table in
#                  this database, so this file is it.
#   jellyfin-config Jellyfin's own library database and settings. Losing this
#                  means a full rescan and every watched flag gone.
#   .env           the secrets. Kept OUT of the repo deliberately — a .env.bak
#                  was briefly committed once, which is why backups live here.
#   compose        so the stack can be stood up again as it was.
#
# The database is snapshotted with VACUUM INTO rather than copied. A plain copy
# of a live SQLite file can be torn mid-write and restore to a corrupt database,
# which is the worst kind of backup: one that exists and does not work. VACUUM
# INTO takes a consistent snapshot of a running database and compacts it on the
# way out.
#
# Media is NOT backed up. It is 915 GB, it already lives on E:, and it is
# replaceable. This is the irreplaceable part.

set -uo pipefail

# Host-specific paths live in $HOME/.config/watch/jellyfin-gate, so this file is the
# same on every machine; each restore used to mean hand-editing it. Unset is an
# error rather than a guess: a backup written to the wrong disk is the failure
# this job exists to prevent. See HOST-SETUP.md for the file's contents.
[ -r $HOME/.config/watch/jellyfin-gate ] && . $HOME/.config/watch/jellyfin-gate
REPO="${JFG_REPO:?set JFG_REPO in $HOME/.config/watch/jellyfin-gate}"
DEST_ROOT="${JFG_BACKUP_ROOT:?set JFG_BACKUP_ROOT in $HOME/.config/watch/jellyfin-gate}"
STAMP=$(date +%Y-%m-%d)
DEST="$DEST_ROOT/$STAMP"
KEEP=6            # weekly, so roughly six weeks of history
FAILED=0

log() { echo "[$(date +%H:%M:%S)] $*"; }
fail() { log "FAILED: $*"; FAILED=1; }

# ON THE MAC, NOTHING HERE TOUCHES THE DRIVE DIRECTLY. macOS refuses a launchd
# job's programs access to an external drive, file by file and program by
# program (first run, 2026-10-14: the shell and gzip were refused). Docker has
# that access, so every step that reads or writes the backup folder runs in a
# container with it mounted at /b. Testing that the folder exists is allowed,
# and is what stops Docker creating it on the Mac's own disk when the drive is
# unplugged.
[ -d "$DEST_ROOT" ] || { log "backup drive not connected at $DEST_ROOT — aborting"; exit 1; }

log "backing up to $DEST"
docker run --rm -v "$DEST_ROOT":/b alpine sh -c "mkdir -p /b/$STAMP && rm -f /b/$STAMP/gate-data.db" || { log "cannot write to the backup drive — aborting"; exit 1; }

# --- 1. the gate database, consistently -------------------------------------
# The snapshot is written beside the database, in the same volume, so a
# container can compress it straight onto the drive without it passing
# through the Mac's own filesystem.
DATA_VOLUME=$(docker inspect jellyfin-gate --format '{{range .Mounts}}{{if eq .Destination "/app/data"}}{{.Name}}{{end}}{{end}}' 2>/dev/null)
[ -n "$DATA_VOLUME" ] || fail "cannot find the gate container's /app/data volume"
log "snapshotting gate database (VACUUM INTO)"
docker exec -u 0 jellyfin-gate rm -f /app/data/.backup-snapshot.db 2>/dev/null
if docker exec jellyfin-gate node -e "
  const s = require('node:sqlite');
  const d = new s.DatabaseSync('/app/data/jellyfin-gate.db');
  d.exec(\"VACUUM INTO '/app/data/.backup-snapshot.db'\");
  const c = new s.DatabaseSync('/app/data/.backup-snapshot.db');
  const chk = c.prepare('PRAGMA quick_check').get()['quick_check'];
  if (chk !== 'ok') { console.error('snapshot failed integrity:', chk); process.exit(1); }
  console.log('snapshot ok, user_version', c.prepare('PRAGMA user_version').get().user_version);
"; then
  docker run --rm -v "$DATA_VOLUME":/src:ro -v "$DEST_ROOT":/b alpine sh -c \
    "gzip -c /src/.backup-snapshot.db > /b/$STAMP/gate-data.db.gz && gzip -t /b/$STAMP/gate-data.db.gz" \
    && log "gate database done" || fail "copying gate database out"
else
  fail "gate database snapshot"
fi
docker exec -u 0 jellyfin-gate rm -f /app/data/.backup-snapshot.db 2>/dev/null

# --- 2. Jellyfin's config volume --------------------------------------------
# Whatever the compose project is called on this machine: the volume name is
# project-prefixed, and hard-coding it broke the first backup on a new host.
CONFIG_VOLUME=$(docker inspect jellyfin --format '{{range .Mounts}}{{if eq .Destination "/config"}}{{.Name}}{{end}}{{end}}' 2>/dev/null)
[ -n "$CONFIG_VOLUME" ] || fail "cannot find the jellyfin container's /config volume"
log "archiving jellyfin config volume"
if docker run --rm \
     -v "$CONFIG_VOLUME":/src:ro \
     -v "$DEST_ROOT":/b \
     alpine sh -c "tar czf /b/$STAMP/jellyfin-config.tar.gz -C /src ." 2>/dev/null; then
  log "jellyfin config done"
else
  fail "jellyfin config archive"
fi

# --- 3. the files that are not in git ---------------------------------------
# env.backup holds every secret the stack has. exFAT keeps no permissions, so
# what protects it is who can reach the drive.
log "copying env and compose"
docker run --rm -v "$REPO":/repo:ro -v "$DEST_ROOT":/b alpine sh -c \
  "cp /repo/.env /b/$STAMP/env.backup && cp /repo/docker-compose.yml /b/$STAMP/docker-compose.yml && { cp /repo/docker-compose.override.yml /b/$STAMP/docker-compose.override.yml 2>/dev/null; true; }" \
  || fail "copying .env and compose"

# --- 4. a manifest, so a restorer knows what they are looking at ------------
{
  echo "jellyfin-gate backup"
  echo "taken:        $(date -Is)"
  echo "host:         $(hostname) ($(uname -sm))"
  echo "git commit:   $(git -C "$REPO" rev-parse --short HEAD 2>/dev/null)"
  echo "git branch:   $(git -C "$REPO" rev-parse --abbrev-ref HEAD 2>/dev/null)"
  echo ""
  echo "contents:"
  docker run --rm -v "$DEST_ROOT":/b:ro alpine sh -c "ls -lh /b/$STAMP" | tail -n +2 | awk '{print "  " $5 "\t" $9}'
  echo ""
  echo "restore: gunzip gate-data.db.gz and put it at /app/data/jellyfin-gate.db"
  echo "         in the gate-data volume; untar jellyfin-config.tar.gz into the"
  echo "         jellyfin-config volume; copy env.backup back to .env."
} | docker run --rm -i -v "$DEST_ROOT":/b alpine sh -c "cat > /b/$STAMP/MANIFEST.txt" || fail "writing the manifest"

# --- 5. prune old backups ---------------------------------------------------
# A ceiling only: jellyfin-gate-backup.sh, which calls this, keeps just the
# newest once it has read it back.
docker run --rm -v "$DEST_ROOT":/b alpine sh -c "
  c=\$(ls -1d /b/20* 2>/dev/null | wc -l)
  [ \"\$c\" -gt $KEEP ] && ls -1d /b/20* | sort | head -n \$((c - $KEEP)) | while read -r old; do echo \"  removing \$old\"; rm -rf \"\$old\"; done
  echo \"total: \$(du -sh /b/$STAMP | cut -f1)\""

if [ "$FAILED" -eq 0 ]; then
  log "BACKUP OK"
else
  log "BACKUP INCOMPLETE — see failures above"
fi
exit "$FAILED"
