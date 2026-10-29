#!/bin/bash
# The nightly health check. Run at 04:30 by the com.watch.health launchd agent,
# or by hand any time: bash ~/watch-host/watch-health.sh
#
# Everything here was once checked by hand, in a chat, at the cost of an AI
# session (2026-10-27..29): the drive dropping out, containers left running
# but blind after it came back, Jellyfin holding stream lists from before a
# file was rewritten, damaged and missing episodes. This does the same reading
# for nothing, every night.
#
# READ-ONLY. It changes nothing: no restarts, no refreshes, no deletes. What
# to do about a finding is the owner's call (HANDOFF.md's rules), and each
# finding says what the fix is.
#
# Writes ~/Library/Logs/watch-health/<date>.txt (and latest.txt), keeps 30
# days of them, and puts up a macOS notification only when something wants
# attention.
DRIVE="${WATCH_DRIVE:-/Volumes/Elements}"
REPO="$HOME/watch"
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="$HOME/Library/Logs/watch-health"
mkdir -p "$OUT_DIR"
REPORT="$OUT_DIR/$(date '+%Y-%m-%d').txt"
problems=0
flag() { problems=$((problems + 1)); echo "  ! $*"; }
ok() { echo "  ok: $*"; }

{
echo "Watch health, $(date '+%A %-d %B %Y, %H:%M')"
echo

echo "DRIVE"
if [ -d "$DRIVE/Da Moveesh" ]; then
  ok "$DRIVE is mounted, $(df -h "$DRIVE" | awk 'NR==2 {print $4}') free"
else
  flag "$DRIVE is not mounted. The site cannot play anything until it is back (com.watch.up starts it again)."
fi
# Dropouts in the last day, as com.watch.up saw them.
if [ -f "$HOME/Library/Logs/watch-up.log" ]; then
  yesterday=$(date -v-1d '+%Y-%m-%d %H:%M:%S')
  drops=$(awk -v since="[$yesterday]" '$0 >= since && /drive is gone|restarting OrbStack|not mounted/' "$HOME/Library/Logs/watch-up.log" | wc -l | tr -d ' ')
  [ "$drops" -gt 0 ] && flag "$drops drive dropout line(s) in watch-up.log in the last day. Elements should be on its own back port, not sharing with My Passport."
fi
echo

echo "CONTAINERS"
if ! docker info >/dev/null 2>&1; then
  flag "Docker (OrbStack) is not running."
else
  running=$(docker ps --format '{{.Names}}')
  for c in jellyfin jellyfin-gate jellyfin-gate-worker jellyfin-gate-console; do
    echo "$running" | grep -qx "$c" || flag "$c is not running."
  done
  # Running is not enough: after a drive drops out and comes back inside
  # com.watch.up's two minutes, containers stay up with an empty /media.
  for c in jellyfin jellyfin-gate jellyfin-gate-worker; do
    echo "$running" | grep -qx "$c" || continue
    n=$(docker exec "$c" sh -c 'ls /media 2>/dev/null | wc -l' 2>/dev/null | tr -d ' ')
    if [ "${n:-0}" -gt 0 ]; then ok "$c sees /media ($n folders)"
    else flag "$c cannot see /media. Fix: quit and reopen OrbStack (it holds a stale view of a re-plugged drive), then start the containers."
    fi
  done
  errors=$(docker logs --since 24h jellyfin-gate-worker 2>&1 | grep -c -i -E '\berror\b|ENOENT|EPERM' || true)
  [ "${errors:-0}" -gt 0 ] && echo "  worker: $errors error line(s) in the last day (docker logs --since 24h jellyfin-gate-worker)"
fi
echo

echo "SITE"
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:3000/login)
[ "$code" = "200" ] && ok "answers locally" || flag "local /login answered $code."
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 25 https://watch.abhigyanverma.com/login)
[ "$code" = "200" ] && ok "answers at watch.abhigyanverma.com" || flag "public /login answered $code (530 = tunnel down, 502 = tunnel up but site not answering)."
# Merged but not deployed: Deploy fast-forwards ~/watch to what it ships.
if git -C "$REPO" fetch -q origin platform-additions 2>/dev/null; then
  behind=$(git -C "$REPO" rev-list --count HEAD..FETCH_HEAD 2>/dev/null || echo 0)
  if [ "${behind:-0}" -gt 0 ]; then
    echo "  merged but not deployed: $behind commit(s). Watch Control, Deploy latest."
    git -C "$REPO" log --oneline --merges HEAD..FETCH_HEAD | sed 's/^/    /'
  else
    ok "running the latest merged code ($(git -C "$REPO" log -1 --format=%h))"
  fi
fi
echo

if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx jellyfin-gate-worker; then
  library=$(docker exec -i jellyfin-gate-worker node --disable-warning=ExperimentalWarning --input-type=module - < "$HERE/watch-health-checks.mjs" 2>&1)
  echo "$library" | grep -v '^PROBLEMS '
  more=$(echo "$library" | sed -n 's/^PROBLEMS //p')
  problems=$((problems + ${more:-1}))
else
  echo "LIBRARY"
  flag "skipped: the worker is not running."
fi
echo
echo "$problems thing(s) to look at."
echo "$problems" > "$OUT_DIR/.problems"
} > "$REPORT" 2>&1

cp "$REPORT" "$OUT_DIR/latest.txt"
find "$OUT_DIR" -name '20*.txt' -mtime +30 -delete

problems=$(cat "$OUT_DIR/.problems" 2>/dev/null || echo 0)
if [ "${problems:-0}" -gt 0 ]; then
  osascript -e "display notification \"$problems thing(s) to look at. Report: ~/Library/Logs/watch-health/latest.txt\" with title \"Watch health\"" 2>/dev/null
fi
exit 0
