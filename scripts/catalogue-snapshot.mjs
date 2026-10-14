#!/usr/bin/env node
/**
 * Checks, against the live library, that the catalogue state lists exactly
 * what the old rule did (docs/catalogue-state.md, 6.2).
 *
 *   ADMIN_API_KEY=... node scripts/catalogue-snapshot.mjs http://127.0.0.1:3000
 *
 * Prints how many files each kind of list shows before and after, and every
 * file where the two disagree. Exits 1 if any do. Read-only.
 */

const base = (process.argv[2] ?? "http://127.0.0.1:3000").replace(/\/+$/, "");
const key = process.env.ADMIN_API_KEY ?? "";
if (!key) {
  console.error("ADMIN_API_KEY is not set.");
  process.exit(2);
}

const res = await fetch(`${base}/api/admin/catalogue/snapshot`, {
  headers: { "x-admin-key": key },
  signal: AbortSignal.timeout(120_000),
});
if (!res.ok) {
  console.error(`${res.status} ${res.statusText}: ${await res.text()}`);
  process.exit(2);
}
const { files, listed, differences } = await res.json();

console.log(`${files} files in the library.`);
for (const [context, n] of Object.entries(listed)) {
  console.log(`  ${context.padEnd(14)} listed before ${String(n.before).padStart(5)}, now ${String(n.now).padStart(5)}`);
}
if (differences.length === 0) {
  console.log("No differences.");
  process.exit(0);
}
console.log(`${differences.length} difference(s):`);
for (const d of differences) {
  console.log(`  ${d.context}: ${d.before ? "was listed, now hidden" : "was hidden, now listed"}  ${d.name}  (${d.path ?? "no path"})`);
}
process.exit(1);
