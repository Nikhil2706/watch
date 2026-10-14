import assert from "node:assert/strict";
import { test } from "node:test";

import { assetUrls, judgeHealth, parseArgs, runSmoke } from "./smoke.mjs";

const LOGIN = `<!DOCTYPE html><html><head>
<link rel="stylesheet" href="/_next/static/css/a1.css" data-precedence="next"/>
<link rel="preload" as="script" href="/_next/static/chunks/webpack-1.js"/>
<script src="/_next/static/chunks/main-app-2.js" async=""></script>
<script src="/_next/static/chunks/main-app-2.js" async=""></script>
<script src="https://elsewhere.example/x.js"></script>
<link rel="manifest" href="/manifest.json"/>
</head></html>`;

test("asset discovery: same-origin /_next/static js and css, deduplicated", () => {
  assert.deepEqual(assetUrls(LOGIN), ["/_next/static/css/a1.css", "/_next/static/chunks/webpack-1.js", "/_next/static/chunks/main-app-2.js"]);
  assert.deepEqual(assetUrls(LOGIN, 1), ["/_next/static/css/a1.css"]);
  assert.deepEqual(assetUrls("<html></html>"), []);
});

test("health: ok and warning pass, critical and errors fail", () => {
  assert.equal(judgeHealth(200, { overall: "ok" }).ok, true);
  assert.equal(judgeHealth(200, { overall: "warning" }).ok, true);
  assert.equal(judgeHealth(200, { overall: "critical" }).ok, false);
  assert.match(judgeHealth(401, null).detail, /wrong ADMIN_API_KEY/);
  assert.equal(judgeHealth(500, { error: "internal_error" }).ok, false);
  assert.equal(judgeHealth(200, null).ok, false);
});

test("arguments", () => {
  assert.deepEqual(parseArgs(["http://127.0.0.1:3100/"], { ADMIN_API_KEY: "k" }), {
    baseUrl: "http://127.0.0.1:3100",
    container: "jellyfin-gate-dev",
    docker: true,
    adminKey: "k",
  });
  assert.equal(parseArgs(["http://x", "--container", "c"], {}).container, "c");
  assert.equal(parseArgs(["http://x", "--no-docker"], {}).docker, false);
  assert.throws(() => parseArgs([], {}), /usage/);
  assert.throws(() => parseArgs(["http://x", "--write"], {}), /unknown argument/);
});

function fakeSite(over = {}) {
  const calls = [];
  const pages = {
    "/login": { status: 200, type: "text/html; charset=utf-8", text: LOGIN },
    "/_next/static/css/a1.css": { status: 200, type: "text/css", text: "a{}" },
    "/_next/static/chunks/webpack-1.js": { status: 200, type: "application/javascript", text: "1" },
    "/_next/static/chunks/main-app-2.js": { status: 200, type: "application/javascript", text: "2" },
    "/manifest.json": { status: 200, type: "application/json", text: "{}" },
    "/sw.js": { status: 200, type: "application/javascript", text: "self" },
    "/api/admin/health": { status: 200, type: "application/json", text: JSON.stringify({ overall: "warning" }) },
    ...over,
  };
  return {
    calls,
    io: {
      get: async (url, headers = {}) => {
        const path = new URL(url).pathname;
        calls.push({ path, headers });
        return pages[path] ?? { status: 404, type: "text/html", text: "not found" };
      },
      dockerLogs: async (c) => ({ ok: true, text: `▲ Next.js\n[boot] database ready\n(${c})` }),
    },
  };
}

const OPTS = { baseUrl: "http://127.0.0.1:3100", container: "jellyfin-gate-dev", docker: true, adminKey: "secret" };

test("a healthy copy passes every check, with GETs only", async () => {
  const { io, calls } = fakeSite();
  const results = await runSmoke(OPTS, io);
  assert.deepEqual(results.map((r) => [r.name, r.ok]), [
    ["/login is 200", true],
    ["static assets load", true],
    ["/api/admin/health ok", true],
    ['boot log says "[boot] database ready"', true],
  ]);
  assert.equal(calls.find((c) => c.path === "/api/admin/health").headers["X-Admin-Key"], "secret");
});

test("each failure is caught and named", async () => {
  const { io } = fakeSite({
    "/sw.js": { status: 307, type: "text/html", text: "" },
    "/api/admin/health": { status: 200, type: "application/json", text: JSON.stringify({ overall: "critical" }) },
  });
  io.dockerLogs = async () => ({ ok: true, text: "Error: Cannot open database" });
  const results = await runSmoke(OPTS, io);
  const failed = Object.fromEntries(results.filter((r) => !r.ok).map((r) => [r.name, r.detail]));
  assert.deepEqual(Object.keys(failed), ["static assets load", "/api/admin/health ok", 'boot log says "[boot] database ready"']);
  assert.match(failed["static assets load"], /\/sw\.js → 307/);
});

test("login down, no key, no docker", async () => {
  const { io } = fakeSite({ "/login": { status: 502, type: "text/html", text: "Bad gateway" } });
  io.dockerLogs = async () => ({ ok: false, text: "Error: No such container: jellyfin-gate-dev" });
  const results = await runSmoke({ ...OPTS, adminKey: "" }, io);
  assert.ok(results.every((r) => !r.ok));
  assert.match(results[2].detail, /ADMIN_API_KEY is not set/);
  assert.match(results[3].detail, /No such container/);
  // --no-docker leaves the log check out.
  assert.equal((await runSmoke({ ...OPTS, docker: false }, fakeSite().io)).length, 3);
});

test("a network error is a failed check, not a crash", async () => {
  const { io } = fakeSite();
  io.get = async () => {
    throw new TypeError("fetch failed");
  };
  const results = await runSmoke({ ...OPTS, docker: false }, io);
  assert.ok(results.every((r) => !r.ok));
  assert.match(results[0].detail, /fetch failed/);
});
