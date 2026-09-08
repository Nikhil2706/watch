#!/usr/bin/env bash
#
# Back the stack up to E:, which is a different physical disk from the failing
# boot SSD. Run from inside the Ubuntu WSL distro.
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

REPO=/mnt/c/Users/Dell/Downloads/jellyfin-gate
DEST_ROOT=/mnt/e/jellyfin-gate-backups
STAMP=$(date +%Y-%m-%d)
DEST="$DEST_ROOT/$STAMP"
KEEP=6            # weekly, so roughly six weeks of history
FAILED=0

log() { echo "[$(date +%H:%M:%S)] $*"; }
fail() { log "FAILED: $*"; FAILED=1; }

log "backing up to $DEST"
mkdir -p "$DEST" || { log "cannot write to E: — aborting"; exit 1; }

# --- 1. the gate database, consistently -------------------------------------
log "snapshotting gate database (VACUUM INTO)"
docker exec jellyfin-gate rm -f /tmp/gate-backup.db 2>/dev/null
if docker exec jellyfin-gate node -e "
  const s = require('node:sqlite');
  const d = new s.DatabaseSync('/app/data/jellyfin-gate.db');
  d.exec(\"VACUUM INTO '/tmp/gate-backup.db'\");
  const c = new s.DatabaseSync('/tmp/gate-backup.db');
  const chk = c.prepare('PRAGMA quick_check').get()['quick_check'];
  if (chk !== 'ok') { console.error('snapshot failed integrity:', chk); process.exit(1); }
  console.log('snapshot ok, user_version', c.prepare('PRAGMA user_version').get().user_version);
"; then
  docker cp jellyfin-gate:/tmp/gate-backup.db "$DEST/gate-data.db" && \
    gzip -f "$DEST/gate-data.db" && log "gate database done" || fail "copying gate database out"
  docker exec jellyfin-gate rm -f /tmp/gate-backup.db 2>/dev/null
else
  fail "gate database snapshot"
fi

# --- 2. Jellyfin's config volume --------------------------------------------
log "archiving jellyfin config volume"
if docker run --rm \
     -v jellyfin-gate_jellyfin-config:/src:ro \
     -v "$DEST":/out \
     alpine sh -c "tar czf /out/jellyfin-config.tar.gz -C /src ." 2>/dev/null; then
  log "jellyfin config done"
else
  fail "jellyfin config archive"
fi

# --- 3. the files that are not in git ---------------------------------------
log "copying env and compose"
cp "$REPO/.env" "$DEST/env.backup" 2>/dev/null || fail "copying .env"
cp "$REPO/.env.wsl-paths" "$DEST/env.wsl-paths.backup" 2>/dev/null || true
cp "$REPO/docker-compose.yml" "$DEST/docker-compose.yml" 2>/dev/null || fail "copying compose"
# Readable only by the owner: this file holds every secret the stack has.
chmod 600 "$DEST/env.backup" 2>/dev/null

# --- 4. a manifest, so a restorer knows what they are looking at ------------
{
  echo "jellyfin-gate backup"
  echo "taken:        $(date -Is)"
  echo "host uptime:  $(uptime -p 2>/dev/null)"
  echo "git commit:   $(git -C "$REPO" rev-parse --short HEAD 2>/dev/null)"
  echo "git branch:   $(git -C "$REPO" rev-parse --abbrev-ref HEAD 2>/dev/null)"
  echo ""
  echo "contents:"
  ls -lh "$DEST" | tail -n +2 | awk '{print "  " $5 "\t" $9}'
  echo ""
  echo "restore: gunzip gate-data.db.gz and put it at /app/data/jellyfin-gate.db"
  echo "         in the gate-data volume; untar jellyfin-config.tar.gz into the"
  echo "         jellyfin-config volume; copy env.backup back to .env."
} > "$DEST/MANIFEST.txt"

# --- 5. prune old backups ---------------------------------------------------
COUNT=$(ls -1d "$DEST_ROOT"/20* 2>/dev/null | wc -l)
if [ "$COUNT" -gt "$KEEP" ]; then
  log "pruning oldest, keeping $KEEP"
  ls -1d "$DEST_ROOT"/20* | sort | head -n -"$KEEP" | while read -r old; do
    log "  removing $old"
    rm -rf "$old"
  done
fi

log "total: $(du -sh "$DEST" 2>/dev/null | cut -f1)"
if [ "$FAILED" -eq 0 ]; then
  log "BACKUP OK"
else
  log "BACKUP INCOMPLETE — see failures above"
fi
exit "$FAILED"
