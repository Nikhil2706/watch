#!/bin/bash
# How many streams are playing right now. Check this before any build,
# restart or deploy: the owner's rule is never to interrupt someone watching.
KEY=$(sed -n 's/^JELLYFIN_API_KEY=//p' "$HOME/watch/.env" | tr -d '"\r')
docker exec jellyfin curl -sS --max-time 20 "http://127.0.0.1:8096/Sessions?api_key=$KEY" 2>/dev/null | grep -o '"NowPlayingItem"' | wc -l | tr -d ' '
