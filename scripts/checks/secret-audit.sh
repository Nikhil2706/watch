#!/usr/bin/env bash
#
# Checks the actual VALUES in .env against every commit about to be pushed.
# Prints only whether each was found — never the value itself.
#
# Why values and not filenames: a secret can arrive inside a file whose name
# looks innocent. A copy of .env was nearly committed on 2026-09-05 because
# .gitignore listed .env by exact name and the backup was called .env.bak-*.
#
# Note the length threshold below skips very short values; OMDb keys are 8
# characters, so check that one by hand or lower the bound.
#
# Usage:  bash scripts/checks/secret-audit.sh [branch]
# Run from the repo root wherever it is checked out, rather than a hardcoded
# path that only resolves in one shell.
cd "$(dirname "$0")/../.." || exit 1
BRANCH="${1:-platform-additions}"
RANGE="origin/$BRANCH..HEAD"
found=0
while IFS='=' read -r name value; do
  case "$name" in ''|\#*) continue;; esac
  value="${value%\"}"; value="${value#\"}"; value="${value%$'\r'}"
  # only test values long enough to be a real credential
  [ ${#value} -lt 12 ] && continue
  case "$name" in *KEY*|*TOKEN*|*SECRET*|*PASSWORD*)
      if git log -p "$RANGE" 2>/dev/null | grep -qF -- "$value"; then
        echo "  !! $name VALUE APPEARS in the commits to be pushed"
        found=1
      else
        echo "  ok  $name — not present"
      fi
      ;;
  esac
done < .env
echo
if [ "$found" -eq 0 ]; then echo "  RESULT: no secret values found in the range"; else echo "  RESULT: STOP - do not push"; fi
