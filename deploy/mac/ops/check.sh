#!/bin/bash
# check.sh [worktree]   -- type-check and tests, in a throwaway container.
REPO="${1:-$HOME/watch}"
docker run --rm -v "$REPO":/app -v watch-npm-cache:/root/.npm -w /app node:22-alpine sh -c '
  if [ ! -d node_modules/typescript ]; then
    npm ci --no-audit --no-fund >/tmp/npmci.log 2>&1 || { echo "NPM CI FAILED"; tail -20 /tmp/npmci.log; exit 1; }
  fi
  echo "=== tsc ==="; npx tsc --noEmit && echo "TSC OK"
  echo "=== tests ==="; npm test 2>&1 | tail -30'
