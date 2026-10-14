#!/usr/bin/env node
/**
 * Smoke test for a running copy of the site, before it goes live.
 *
 *   ADMIN_API_KEY=... node scripts/smoke.mjs http://127.0.0.1:3100 [--container jellyfin-gate-dev]
 *
 * What the deploy button runs against the Mac's test copy (:3100) before
 * putting the same build live. Read-only by design: GET requests only, and
 * `docker logs`. No browser, no sign-in, no writes — nothing here can change
 * the copy it checks.
 *
 * Checks:
 *   1. /login answers 200 with HTML.
 *   2. Static assets load: the scripts and styles /login links to (up to 4),
 *      plus manifest.json and sw.js, which the middleware must let through
 *      signed out.
 *   3. /api/admin/health answers 200 to X-Admin-Key, with an `overall` that is
 *      not "critical". A "warning" is printed, not failed: a test copy usually
 *      has something to warn about (no recent library scan, say).
 *      Without ADMIN_API_KEY this check fails: it is the one that proves the
 *      server reached its database and Jellyfin.
 *   4. The container's boot log says "[boot] database ready" (docker logs).
 *      --no-docker skips this when the copy isn't a container.
 *
 * Exit 0 when everything passed, 1 otherwise; one line per check either way.
 */

import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";

const TIMEOUT_MS = 20_000;
const BOOT_LINE = "[boot] database ready";

export function parseArgs(argv, env = process.env) {
  const opts = { baseUrl: null, container: "jellyfin-gate-dev", docker: true, adminKey: env.ADMIN_API_KEY ?? "" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--container") opts.container = argv[++i];
    else if (a.startsWith("--container=")) opts.container = a.slice("--container=".length);
    else if (a === "--no-docker") opts.docker = false;
    else if (!a.startsWith("--") && !opts.baseUrl) opts.baseUrl = a;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!opts.baseUrl) throw new Error("usage: node scripts/smoke.mjs <baseUrl> [--container NAME] [--no-docker]");
  opts.baseUrl = opts.baseUrl.replace(/\/+$/, "");
  return opts;
}

/** Same-origin script and stylesheet URLs a page links to, in order, without duplicates. */
export function assetUrls(html, limit = 4) {
  const found = [];
  for (const m of html.matchAll(/<(?:script|link)\b[^>]*?\b(?:src|href)="([^"]+)"/g)) {
    const url = m[1].replace(/&amp;/g, "&");
    if (/^\/_next\/static\/.+\.(js|css)(\?|$)/.test(url) && !found.includes(url)) found.push(url);
  }
  return found.slice(0, limit);
}

/** The verdict on the health snapshot. */
export function judgeHealth(status, body) {
  if (status === 401) return { ok: false, detail: "401: wrong ADMIN_API_KEY for this copy" };
  if (status !== 200) return { ok: false, detail: `HTTP ${status}` };
  const overall = body && typeof body === "object" ? body.overall : undefined;
  if (overall === "ok") return { ok: true, detail: "overall ok" };
  if (overall === "warning") return { ok: true, detail: "overall warning (not blocking)" };
  if (overall === "critical") return { ok: false, detail: "overall critical" };
  return { ok: false, detail: "no `overall` in the response" };
}

async function get(url, headers = {}) {
  const res = await fetch(url, { headers, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = await res.text();
  return { status: res.status, type: res.headers.get("content-type") ?? "", text };
}

function dockerLogs(container) {
  return new Promise((resolve) => {
    execFile("docker", ["logs", container], { maxBuffer: 64 * 1024 * 1024, timeout: TIMEOUT_MS }, (err, stdout, stderr) => {
      resolve(err ? { ok: false, text: String(stderr || err.message).trim() } : { ok: true, text: `${stdout}\n${stderr}` });
    });
  });
}

export async function runSmoke(opts, io = { get, dockerLogs }) {
  const results = [];
  const check = async (name, fn) => {
    try {
      const r = await fn();
      results.push({ name, ...r });
    } catch (error) {
      results.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
  };
  const base = opts.baseUrl;
  let loginHtml = "";

  await check("/login is 200", async () => {
    const r = await io.get(`${base}/login`);
    loginHtml = r.text;
    if (r.status !== 200) return { ok: false, detail: `HTTP ${r.status}` };
    if (!/text\/html/.test(r.type)) return { ok: false, detail: `content-type ${r.type}` };
    return { ok: true, detail: "" };
  });

  const assets = assetUrls(loginHtml);
  await check("static assets load", async () => {
    if (assets.length === 0) return { ok: false, detail: "no /_next/static scripts or styles linked from /login" };
    const paths = [...assets, "/manifest.json", "/sw.js"];
    const bad = [];
    for (const p of paths) {
      const r = await io.get(`${base}${p}`);
      if (r.status !== 200 || r.text.length === 0) bad.push(`${p} → ${r.status}`);
    }
    return bad.length ? { ok: false, detail: bad.join(", ") } : { ok: true, detail: `${paths.length} files` };
  });

  await check("/api/admin/health ok", async () => {
    if (!opts.adminKey) return { ok: false, detail: "ADMIN_API_KEY is not set" };
    const r = await io.get(`${base}/api/admin/health`, { "X-Admin-Key": opts.adminKey });
    let body = null;
    try {
      body = JSON.parse(r.text);
    } catch {
      /* judged below */
    }
    return judgeHealth(r.status, body);
  });

  if (opts.docker) {
    await check(`boot log says "${BOOT_LINE}"`, async () => {
      const logs = await io.dockerLogs(opts.container);
      if (!logs.ok) return { ok: false, detail: `docker logs ${opts.container}: ${logs.text}` };
      return logs.text.includes(BOOT_LINE) ? { ok: true, detail: opts.container } : { ok: false, detail: `not in docker logs ${opts.container}` };
    });
  }
  return results;
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  const results = await runSmoke(opts);
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(failed ? `\n${failed} of ${results.length} checks failed — do not deploy.` : `\nall ${results.length} checks passed.`);
  process.exit(failed ? 1 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
