#!/usr/bin/env bash
# Parses every inline <script> in curator.html.
#
# The console is a single 240KB file of hand-written JS that nothing compiles,
# so a syntax error is invisible until the page is opened — and it breaks the
# WHOLE dashboard, not just the part that was edited. This catches that in a
# second, without a rebuild or a browser.
#
# Runs inside the existing gate image, so it needs no local node.
set -uo pipefail
REPO=${1:-/mnt/c/Users/Dell/Downloads/jellyfin-gate}
docker run --rm --user 0 -v "$REPO":/src -w /src --entrypoint node jellyfin-gate-gate -e '
const fs = require("fs");
const html = fs.readFileSync("curator.html", "utf8");
const blocks = [...html.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
if (!blocks.length) { console.log("no inline script found"); process.exit(1); }
let bad = 0;
blocks.forEach((b, i) => {
  try { new Function(b); console.log("script block " + (i + 1) + ": OK (" + b.split("\n").length + " lines)"); }
  catch (e) { bad++; console.log("script block " + (i + 1) + ": SYNTAX ERROR " + e.message); }
});
process.exit(bad ? 1 : 0);
'
