import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";

/**
 * No fixed "first N" where everything is meant.
 *
 * A fixed Limit on a Jellyfin query cut the library three times as it grew
 * past it (200, then 2000 in the admin listing, then 2000 again in the
 * viewers' listing and cast list on 2026-11-06), each time quietly. Fetch
 * everything with everyPage (jellyfin-listing.ts). A fixed limit of
 * FIXED_LIMIT_MAX or more fails here unless the same line pages (StartIndex):
 * a short row ("20 newest") is fine, "500 of them" is a cap in waiting.
 */
const FIXED_LIMIT_MAX = 500;
const ROOT = join(import.meta.dirname, "..", "..");
const SKIP = new Set(["node_modules", ".next", ".git"]);
/** Not Jellyfin: a request rate limit. */
const NOT_JELLYFIN = new Set(["src/lib/ratelimit.ts"]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (SKIP.has(name)) return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|mjs|js)$/.test(name) && !/\.test\./.test(name) ? [path] : [];
  });
}

export function fixedLimits(source: string): Array<{ line: number; text: string }> {
  const found: Array<{ line: number; text: string }> = [];
  source.split("\n").forEach((text, i) => {
    if (/StartIndex/i.test(text) || /^\s*(\*|\/\/)/.test(text)) return;
    for (const m of text.matchAll(/\blimit["']?\s*[:=]\s*["']?(\d+)/gi)) {
      if (Number(m[1]) >= FIXED_LIMIT_MAX) found.push({ line: i + 1, text: text.trim() });
    }
  });
  return found;
}

test("the rule catches the shapes that cut the library before", () => {
  assert.equal(fixedLimits(`fetch("/Items?Recursive=true&Limit=2000")`).length, 1);
  assert.equal(fixedLimits(`getAllMovies(session, { limit: 2000 })`).length, 1);
  assert.equal(fixedLimits(`  limit: 5000,`).length, 1);
  assert.equal(fixedLimits(`getAllMovies(session, { limit: 20 })`).length, 0);
  assert.equal(fixedLimits("`/Items?StartIndex=${s}&Limit=1000`").length, 0);
  assert.equal(fixedLimits(" * Limit=2000, against a library of 1,904.").length, 0);
});

test("no Jellyfin query in the site or its scripts asks for a fixed 500 or more", () => {
  const offenders = [join(ROOT, "src"), join(ROOT, "scripts")]
    .flatMap(sourceFiles)
    .filter((path) => !NOT_JELLYFIN.has(relative(ROOT, path)))
    .flatMap((path) => fixedLimits(readFileSync(path, "utf8")).map((f) => `${relative(ROOT, path)}:${f.line}  ${f.text}`));
  assert.deepEqual(offenders, [], "Page it with everyPage (src/lib/jellyfin-listing.ts) instead of a fixed limit");
});
