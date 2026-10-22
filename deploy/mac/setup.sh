#!/bin/bash
# setup.sh <step>   -- the Mac side of the restore, one step at a time.
# Written on the Windows PC and NEVER RUN ON A MAC: read each step before
# running it, and fix what does not fit this machine. RESTORE-ON-MAC.md says
# when to run which.
#
#   env        write ~/watch/.env and the compose override from the package
#   volumes    create the Docker volumes and fill them from the snapshot
#   console    start the admin console container
#   agents     install the launchd agent (start-up guard)
#   ops        put the day-to-day helper scripts in ~/watch-ops
#   check      the final checks, printed as a list
set -uo pipefail
STEP=${1:-}
PKG="$(cd "$(dirname "$0")/.." && pwd)"
DRIVE="$(cd "$PKG/.." && pwd)"                 # the film drive: the package sits at its top
REPO="$HOME/watch"
P="$PKG/payload"
say() { printf '\n== %s\n' "$*"; }

case "$STEP" in
env)
  [ -d "$REPO" ] || { echo "clone the repo to $REPO first"; exit 1; }
  [ -d "$DRIVE/Da Moveesh" ] || { echo "no film library at $DRIVE/Da Moveesh"; exit 1; }
  mkdir -p "$HOME/watch-data/incoming" "$DRIVE/_Excluded"
  # Every key as it was; only the three host paths and the compose list change.
  grep -v -E '^(MEDIA_PATH|MEDIA_INCOMING|MEDIA_EXCLUDED_PATH|BACKUP_PATH|COMPOSE_FILE|CF_CREDS_DIR|CF_USER|TUNNEL_TOKEN)=' "$P/config/env" > "$REPO/.env"
  {
    echo
    echo "# Host paths for this Mac (written by watch-mac-restore/mac/setup.sh env)"
    echo "MEDIA_PATH=$DRIVE/Da Moveesh"
    echo "MEDIA_EXCLUDED_PATH=$DRIVE/_Excluded"
    echo "MEDIA_INCOMING=$HOME/watch-data/incoming"
    # The worker writes the backup here (scripts/backup.mjs).
    echo "BACKUP_PATH=$DRIVE/jellyfin-gate-backups"
    echo "COMPOSE_FILE=docker-compose.yml:docker-compose.override.yml"
  } >> "$REPO/.env"
  chmod 600 "$REPO/.env"
  cp "$PKG/mac/docker-compose.override.yml" "$REPO/docker-compose.override.yml"
  say "wrote $REPO/.env ($(grep -c '=' "$REPO/.env") settings) and the compose override"
  (cd "$REPO" && docker compose config >/dev/null && echo "compose reads it") || echo "COMPOSE DOES NOT ACCEPT IT - read the error above"
  mkdir -p "$DRIVE/jellyfin-gate-backups" && touch "$DRIVE/jellyfin-gate-backups/.watch-backups"
  (cd "$REPO" && docker compose config | grep -E 'source: .*(Da Moveesh|_Excluded|incoming|jellyfin-gate-backups)' | sort -u)
  ;;

volumes)
  docker ps --format '{{.Names}}' | grep -q '^jellyfin' && { echo "containers are running - stop them first (docker compose down)"; exit 1; }
  if docker volume inspect watch_gate-data >/dev/null 2>&1 && [ "${FORCE:-0}" != 1 ]; then
    echo "watch_gate-data already exists. Restoring over it would replace the site's data."
    echo "Run with FORCE=1 only if that is what you mean."; exit 1
  fi
  ( cd "$P/data" && shasum -a 256 -c <(sed -n '/^sha256:/,$p' MANIFEST.txt | tail -n +2) ) || { echo "CHECKSUM MISMATCH - do not continue"; exit 1; }
  for v in gate-data jellyfin-config jellyfin-cache; do
    docker volume rm "watch_$v" >/dev/null 2>&1
    docker volume create --label com.docker.compose.project=watch --label com.docker.compose.volume=$v "watch_$v" >/dev/null
  done
  say "Jellyfin's config (about 2 GB)"
  docker run --rm -v watch_jellyfin-config:/dst -v "$P/data":/src:ro alpine sh -c 'tar xzf /src/jellyfin-config.tar.gz -C /dst && ls /dst | tr "\n" " "'
  say "the site's database"
  docker run --rm -v watch_gate-data:/dst -v "$P/data":/src:ro alpine sh -c 'gunzip -c /src/gate-data.db.gz > /dst/jellyfin-gate.db && chown -R 1000:1000 /dst && ls -la /dst'
  say "done; the snapshot was:"; sed -n '1,14p' "$P/data/MANIFEST.txt"
  ;;

console)
  mkdir -p "$HOME/console-server"
  cp "$P/console-server/server.mjs" "$P/console-server/console.env" "$HOME/console-server/"
  chmod 600 "$HOME/console-server/console.env"
  docker rm -f jellyfin-gate-console >/dev/null 2>&1
  # Published on every interface, as it was reachable on the home Wi-Fi from
  # the PC: the secret in the address is what protects it. For this Mac only,
  # change -p to 127.0.0.1:3200:3200.
  docker run -d --name jellyfin-gate-console --restart unless-stopped \
    --network watch_internal -p 3200:3200 \
    --env-file "$HOME/console-server/console.env" \
    -e SITE_URL=https://watch.abhigyanverma.com \
    -v "$HOME/console-server/server.mjs":/app/server.mjs:ro \
    -v "$REPO/curator.html":/console/curator.html:ro \
    node:22-alpine node /app/server.mjs >/dev/null
  sleep 3; docker logs jellyfin-gate-console 2>&1 | tail -2
  SECRET=$(grep -o 'localhost:3200/[A-Za-z0-9-]*' "$P/console-server/console-url.txt" | head -1 | cut -d/ -f2)
  IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null)
  {
    echo "Curator console - secret sign-in links. Anyone with one of these has full admin access."
    echo
    echo "On this Mac:            http://localhost:3200/$SECRET"
    [ -n "${IP:-}" ] && echo "On the home Wi-Fi:      http://$IP:3200/$SECRET   (the address changes if the router gives the Mac a new one)"
  } > "$HOME/console-server/console-url.txt"
  chmod 600 "$HOME/console-server/console-url.txt"
  echo "the console's address is in ~/console-server/console-url.txt (not printed here: it is a password)"
  ;;

agents)
  mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs" "$HOME/.config/watch" "$HOME/watch-host"
  cp "$PKG/mac/watch-up.sh" "$PKG/mac/host-jobs/yield-to-fcp.sh" "$HOME/watch-host/" && chmod 755 "$HOME/watch-host/"*.sh
  BREW=$(brew --prefix 2>/dev/null || echo /opt/homebrew)
  DOCKERBIN=$(dirname "$(command -v docker)")
  # The backup runs in the worker now, on the site's schedule: the host-jobs
  # agent that used to run it every minute is taken out if it is there.
  launchctl bootout "gui/$(id -u)/com.watch.hostjobs" 2>/dev/null && echo "removed com.watch.hostjobs"
  rm -f "$HOME/Library/LaunchAgents/com.watch.hostjobs.plist"
  for name in com.watch.up com.watch.yield; do
    sed -e "s#__HOME__#$HOME#g" -e "s#__DRIVE__#$DRIVE#g" -e "s#__BREW__#$BREW#g" -e "s#__DOCKERBIN__#$DOCKERBIN#g" \
      "$PKG/mac/launchd/$name.plist" > "$HOME/Library/LaunchAgents/$name.plist"
    launchctl bootout "gui/$(id -u)/$name" 2>/dev/null
    launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/$name.plist" && echo "loaded $name"
  done
  echo "log: ~/Library/Logs/watch-up.log"
  ;;

ops)
  mkdir -p "$HOME/watch-ops" && cp "$PKG/mac/ops/"*.sh "$HOME/watch-ops/" && chmod 755 "$HOME/watch-ops/"*.sh
  ls "$HOME/watch-ops"
  ;;

check)
  cd "$REPO" || exit 1
  say "containers"; docker ps --format '{{.Names}}\t{{.Status}}'
  say "site"; curl -s -o /dev/null -w 'local  /login: %{http_code}\n' --max-time 10 http://127.0.0.1:3000/login
  curl -s -o /dev/null -w 'public /login: %{http_code}  (530 = tunnel not connected, 502 = tunnel up but site not answering)\n' --max-time 25 https://watch.abhigyanverma.com/login
  curl -s -o /dev/null -w 'console:       %{http_code}\n' --max-time 10 http://127.0.0.1:3200/
  say "database, against the snapshot's manifest"
  docker exec jellyfin-gate node -e '
    const d=new (require("node:sqlite").DatabaseSync)("/app/data/jellyfin-gate.db",{readOnly:true});
    const n=(q)=>d.prepare(q).get().n;
    console.log("schema version: "+d.prepare("PRAGMA user_version").get().user_version);
    console.log("users:          "+n("SELECT COUNT(*) n FROM users"));
    console.log("picks:          "+n("SELECT COUNT(*) n FROM picks"));
    console.log("comments:       "+n("SELECT COUNT(*) n FROM film_comments"));
    console.log("ratings:        "+n("SELECT COUNT(*) n FROM user_ratings"));
    console.log("scheduled jobs: "+n("SELECT COUNT(*) n FROM scheduled_jobs"));'
  echo "-- the manifest said:"; grep -E '^(schema version|users|picks|comments|ratings|scheduled jobs|jellyfin):' "$P/data/MANIFEST.txt"
  say "library"; docker logs jellyfin-gate 2>&1 | grep 'admin library listing warm' | tail -1
  KEY=$(sed -n 's/^JELLYFIN_API_KEY=//p' .env | tr -d '"\r')
  docker exec jellyfin curl -sS --max-time 20 "http://127.0.0.1:8096/Items?recursive=true&includeItemTypes=Movie&limit=0&api_key=$KEY" | grep -o '"TotalRecordCount":[0-9]*'
  say "an old film id still opens (ids survived the move)"
  docker exec jellyfin-gate node -e '
    const d=new (require("node:sqlite").DatabaseSync)("/app/data/jellyfin-gate.db",{readOnly:true});
    const r=d.prepare("SELECT film_href FROM notifications WHERE film_href LIKE \x27/item/%\x27 ORDER BY created_at DESC LIMIT 1").get();
    console.log(r ? r.film_href : "no item link on record")' | while read -r href; do
      id=$(echo "$href" | grep -o '[0-9a-f]\{32\}$'); [ -n "$id" ] && docker exec jellyfin curl -sS -o /dev/null -w "jellyfin has item $id: %{http_code}\n" "http://127.0.0.1:8096/Items?ids=$id&api_key=$KEY"
    done
  say "worker"; docker exec jellyfin-gate-worker ffmpeg -version 2>/dev/null | head -1
  say "agents"; launchctl list | grep -E 'com\.watch|cloudflared' || echo "no agents loaded"
  say "sleep settings"; pmset -g | grep -E ' sleep |disksleep|autorestart'
  ;;

*) sed -n '2,14p' "$0";;
esac
