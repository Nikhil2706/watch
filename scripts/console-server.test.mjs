// End-to-end tests for console-server.mjs: the real server on a spare port,
// a stub gate behind it recording what arrives, plain HTTP in front.
//
//   node --test scripts/console-server.test.mjs

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const TOKEN = "abcd-efgh-2345";
const ADMIN_KEY = "k".repeat(40);
const SERVER = fileURLToPath(new URL("./console-server.mjs", import.meta.url));

const freePort = () =>
  new Promise((resolve) => {
    const s = createServer().listen(0, () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

function http(port, method, path, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

const cookieFor = (issued) =>
  `jfg_console=${issued}.${createHmac("sha256", TOKEN).update(`console:${issued}`).digest("base64url")}`;

let gate, gatePort, port, child;
const seen = [];

before(async () => {
  gatePort = await freePort();
  gate = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
    });
  }).listen(gatePort);

  const dir = mkdtempSync(join(tmpdir(), "console-test-"));
  const html = join(dir, "curator.html");
  writeFileSync(html, "<!doctype html><html><head><title>c</title></head><body>console</body></html>");

  port = await freePort();
  child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      PORT: String(port),
      CONSOLE_TOKEN: TOKEN,
      ADMIN_API_KEY: ADMIN_KEY,
      GATE_URL: `http://127.0.0.1:${gatePort}`,
      SITE_URL: "http://site.example",
      CONSOLE_HTML: html,
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise((resolve) => child.stdout.once("data", resolve));
});

after(() => {
  child?.kill();
  gate?.close();
});

test("without the cookie everything is a plain 404", async () => {
  for (const path of ["/", "/api/admin/health", "/item/x"]) {
    assert.equal((await http(port, "GET", path)).status, 404, path);
  }
});

test("a wrong link is a 404 and sets nothing", async () => {
  const res = await http(port, "GET", "/abcd-efgh-2346");
  assert.equal(res.status, 404);
  assert.equal(res.headers["set-cookie"], undefined);
});

test("the link signs in, in any case, with a strict httpOnly cookie", async () => {
  const res = await http(port, "GET", "/ABCD-EFGH-2345");
  assert.equal(res.status, 303);
  assert.equal(res.headers.location, "/");
  const cookie = String(res.headers["set-cookie"]);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.equal(res.headers["referrer-policy"], "no-referrer");
});

test("signed in, the console is served with the sign-in pre-seeded", async () => {
  const res = await http(port, "GET", "/", { Cookie: cookieFor(Date.now()) });
  assert.equal(res.status, 200);
  assert.match(res.body, /signed-in-by-console-server/);
  assert.match(res.body, /<head><script>/, "boot script must run before the page's own");
  assert.equal(res.headers["cache-control"], "no-store");
});

test("API calls reach the gate with the real key, never the browser's cookie or key", async () => {
  seen.length = 0;
  const res = await http(port, "GET", "/api/admin/health?x=1", {
    Cookie: cookieFor(Date.now()),
    "X-Admin-Key": "whatever-the-page-sent",
    "Sec-Fetch-Site": "same-origin",
  });
  assert.equal(res.status, 200);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "/api/admin/health?x=1");
  assert.equal(seen[0].headers["x-admin-key"], ADMIN_KEY);
  assert.equal(seen[0].headers.cookie, undefined);
});

test("a same-origin POST is forwarded with its body", async () => {
  seen.length = 0;
  const body = JSON.stringify({ a: 1 });
  const res = await http(port, "POST", "/api/admin/thing", {
    Cookie: cookieFor(Date.now()),
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    Origin: `http://127.0.0.1:${port}`,
    Host: `127.0.0.1:${port}`,
    "Sec-Fetch-Site": "same-origin",
  }, body);
  assert.equal(res.status, 200);
  assert.equal(seen[0]?.body, body);
});

test("a cross-site request is refused before it reaches the gate", async () => {
  seen.length = 0;
  const bySite = await http(port, "POST", "/api/admin/invites", {
    Cookie: cookieFor(Date.now()),
    "Sec-Fetch-Site": "cross-site",
  });
  const byOrigin = await http(port, "POST", "/api/admin/invites", {
    Cookie: cookieFor(Date.now()),
    Origin: "https://evil.example",
  });
  assert.equal(bySite.status, 403);
  assert.equal(byOrigin.status, 403);
  assert.equal(seen.length, 0);
});

test("a forged or expired cookie does not sign in", async () => {
  const forged = `jfg_console=${Date.now()}.not-a-real-mac`;
  assert.equal((await http(port, "GET", "/", { Cookie: forged })).status, 404);
  const stale = cookieFor(Date.now() - 31 * 24 * 3600 * 1000);
  assert.equal((await http(port, "GET", "/", { Cookie: stale })).status, 404);
});

test("other paths go to the site itself", async () => {
  const res = await http(port, "GET", "/item/abc", { Cookie: cookieFor(Date.now()) });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, "http://site.example/item/abc");
});

// Last: it exhausts the guess budget for the rest of this server's life.
test("after 50 wrong links new sign-ins pause, but signed-in devices keep working", async () => {
  for (let i = 0; i < 50; i++) await http(port, "GET", `/wrong-guess-${i}`);
  assert.equal((await http(port, "GET", `/${TOKEN}`)).status, 404, "right link refused while paused");
  assert.equal((await http(port, "GET", "/", { Cookie: cookieFor(Date.now()) })).status, 200);
});
