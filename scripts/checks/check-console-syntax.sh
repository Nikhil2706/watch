#!/usr/bin/env bash
# Parses every inline <script> in curator.html.
#
# The console is a single 240KB file of hand-written JS that nothing compiles,
# so a syntax error is invisible until the page is opened — and it breaks the
# WHOLE dashboard, not just the part that was edited. This catches that in a
# second, without a rebuild or a browser.
#
# Runs in a stock node image, so it needs no local node - and not the gate
# image either, whose name follows the compose project and changed with the
# host ("jellyfin-gate-gate" before, "watch-gate" after).
#
# Second argument picks the file, for the other console-shaped page in this repo:
#   bash scripts/checks/check-console-syntax.sh "" dupefinder/console.html
set -uo pipefail
REPO=${1:-}
REPO=${REPO:-$(cd "$(dirname "$0")/../.." && pwd)}
TARGET=${2:-curator.html}
docker run --rm -v "$REPO":/src:ro -w /src -e TARGET="$TARGET" node:22-alpine node -e '
const fs = require("fs");
const html = fs.readFileSync(process.env.TARGET, "utf8");
const blocks = [...html.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
if (!blocks.length) { console.log("no inline script found"); process.exit(1); }
let bad = 0;
blocks.forEach((b, i) => {
  try { new Function(b); console.log("script block " + (i + 1) + ": OK (" + b.split("\n").length + " lines)"); }
  catch (e) { bad++; console.log("script block " + (i + 1) + ": SYNTAX ERROR " + e.message); }
});
process.exit(bad ? 1 : 0);
'
