/**
 * Every stylesheet's braces balance.
 *
 * A merge on 2026-11-11 left `html[data-tv="true"] .end-reading-title {` in
 * tv.css with no body or closing brace. Browsers that understand CSS nesting
 * then read every rule after it as nested inside it, so each one matched
 * nothing: season headings, poster markers, Live TV tiles and badges, and the
 * picker's TV sizes all silently stopped applying. Nothing else catches that.
 *
 * Run:
 *   node --test --experimental-strip-types \
 *        --disable-warning=ExperimentalWarning src/lib/css-braces.test.ts
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";

const ROOT = join(import.meta.dirname, "..", "..");

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : cssFiles(path);
    return name.endsWith(".css") ? [path] : [];
  });
}

/** Braces outside comments and strings; the depth where it first goes wrong. */
export function braceProblem(css: string): string | null {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');
  let depth = 0;
  let line = 1;
  let openedAt: number[] = [];
  for (const ch of text) {
    if (ch === "\n") line += 1;
    else if (ch === "{") {
      depth += 1;
      openedAt.push(line);
    } else if (ch === "}") {
      depth -= 1;
      openedAt.pop();
      if (depth < 0) return `a stray "}" near line ${line}`;
    }
  }
  if (depth > 0) return `${depth} unclosed "{" (one opened near line ${openedAt[openedAt.length - 1]}, lines counted without comments)`;
  return null;
}

test("braceProblem finds an unclosed rule and a stray brace", () => {
  assert.equal(braceProblem(".a { color: red; }\n.b { }"), null);
  assert.match(braceProblem(".a {\n\n/* c */\n.b { color: red; }") ?? "", /unclosed/);
  assert.match(braceProblem(".a { } }") ?? "", /stray/);
  assert.equal(braceProblem('.a::before { content: "{"; }'), null);
});

test("every stylesheet's braces balance", () => {
  const bad = cssFiles(join(ROOT, "src"))
    .map((file) => [relative(ROOT, file), braceProblem(readFileSync(file, "utf8"))] as const)
    .filter(([, problem]) => problem);
  assert.deepEqual(bad, []);
});
