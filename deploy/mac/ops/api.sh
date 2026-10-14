#!/bin/bash
# api.sh dev|prod METHOD PATH [json-body]   -- an admin API call against the
# test copy (127.0.0.1:3100) or the live site (127.0.0.1:3000). The admin key
# is read from ~/watch/.env and never printed.
set -uo pipefail
T=$1; M=$2; P=$3; B=${4:-}
case "$T" in dev) PORT=3100;; prod) PORT=3000;; *) echo "dev|prod"; exit 2;; esac
KEY=$(grep '^ADMIN_API_KEY=' "$HOME/watch/.env" | head -1 | cut -d= -f2- | tr -d '\r"')
if [ -n "$B" ]; then
  curl -s -m "${TIMEOUT:-600}" -X "$M" -H "X-Admin-Key: $KEY" -H 'Content-Type: application/json' -d "$B" "http://127.0.0.1:$PORT$P"
else
  curl -s -m "${TIMEOUT:-600}" -X "$M" -H "X-Admin-Key: $KEY" "http://127.0.0.1:$PORT$P"
fi
echo
