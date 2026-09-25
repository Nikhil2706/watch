#!/usr/bin/env node
// Serves curator.html on this machine, signed in by a secret link, with no
// admin key to type.
//
//   GET /<CONSOLE_TOKEN>  sets a 30-day cookie and redirects to /
//   GET /                 the console (404 without the cookie)
//   /api/*                forwarded to the gate with X-Admin-Key added here,
//                         so the key never reaches the browser
//   anything else         redirected to the site itself ("View on site")
//
// Deliberately NOT part of the gate: it listens on its own port, which the
// Cloudflare tunnel never points at, so the console is not on the internet.
// curator.html is read from disk on every request, so saving it is still a
// deploy, exactly as before.
//
// Env: CONSOLE_TOKEN, ADMIN_API_KEY, GATE_URL (default http://jellyfin-gate:3000),
// SITE_URL (where "View on site" goes; default http://localhost:3000),
// CONSOLE_HTML (default /console/curator.html), PORT (default 3200).

import { createHmac, createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { Readable } from "node:stream";

const TOKEN = process.env.CONSOLE_TOKEN ?? "";
const ADMIN_KEY = process.env.ADMIN_API_KEY ?? "";
const GATE = (process.env.GATE_URL || "http://jellyfin-gate:3000").replace(/\/$/, "");
const SITE = (process.env.SITE_URL || "http://localhost:3000").replace(/\/$/, "");
const HTML = process.env.CONSOLE_HTML || "/console/curator.html";
const PORT = Number(process.env.PORT || 3200);
const COOKIE = "jfg_console";
const MAX_AGE_S = 30 * 24 * 3600;

if (TOKEN.length < 32 || ADMIN_KEY.length < 32) {
  console.error("CONSOLE_TOKEN and ADMIN_API_KEY must both be at least 32 characters.");
  process.exit(1);
}

const digest = (s) => createHash("sha256").update(s).digest();
const sameSecret = (a, b) => timingSafeEqual(digest(a), digest(b));
const sign = (issued) => createHmac("sha256", TOKEN).update(`console:${issued}`).digest("base64url");

function cookieValue(req) {
  const m = (req.headers.cookie || "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  return m ? m[1] : null;
}

/** Valid if signed with the current token and under 30 days old — so
 *  changing CONSOLE_TOKEN signs every device out at once. */
function signedIn(req) {
  const v = cookieValue(req);
  if (!v) return false;
  const [issued, mac] = v.split(".");
  const at = Number(issued);
  if (!Number.isFinite(at) || Date.now() - at > MAX_AGE_S * 1000) return false;
  return !!mac && sameSecret(mac, sign(issued));
}

/**
 * The cookie is sent automatically, so a state-changing request must also
 * prove it came from the console page itself, or any website open in the same
 * browser could post to /api/admin/* through it. Browsers mark cross-site
 * requests in Sec-Fetch-Site and Origin; either is enough to refuse.
 */
function sameOrigin(req) {
  const site = req.headers["sec-fetch-site"];
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = req.headers.origin;
  if (origin && origin !== `http://${req.headers.host}`) return false;
  return true;
}

const notFound = (res) => {
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
};

// Runs before the console's own script: it restores a same-tab "session" from
// sessionStorage and connects, so pre-seeding that is all it takes to skip the
// key form. The key value is a placeholder; the real one is added server-side.
const BOOT = `<script>try{sessionStorage.setItem("jfg_key","signed-in-by-console-server");sessionStorage.setItem("jfg_base",location.origin);}catch(e){}</script>`;

async function serveConsole(res) {
  let html;
  try {
    html = await readFile(HTML, "utf8");
  } catch {
    res.writeHead(500, { "Content-Type": "text/plain" });
    return res.end(`Cannot read ${HTML}`);
  }
  html = html.replace(/<head([^>]*)>/i, (m) => `${m}${BOOT}`);
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
  });
  res.end(html);
}

const HOP = new Set(["host", "connection", "cookie", "x-admin-key", "origin", "referer", "content-length"]);

async function proxy(req, res) {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k) && v !== undefined) headers[k] = v;
  headers["x-admin-key"] = ADMIN_KEY;
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  let upstream;
  try {
    upstream = await fetch(GATE + req.url, {
      method: req.method,
      headers,
      body: hasBody ? req : undefined,
      duplex: hasBody ? "half" : undefined,
      redirect: "manual",
    });
  } catch (e) {
    res.writeHead(502, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "gate_unreachable", message: String(e.message || e) }));
  }
  const out = {};
  upstream.headers.forEach((v, k) => {
    if (k !== "content-encoding" && k !== "transfer-encoding" && k !== "content-length") out[k] = v;
  });
  res.writeHead(upstream.status, out);
  if (upstream.body) Readable.fromWeb(upstream.body).pipe(res);
  else res.end();
}

createServer(async (req, res) => {
  try {
    const path = (req.url || "/").split("?")[0];

    if (path.length > 1 && req.method === "GET" && sameSecret(path.slice(1), TOKEN)) {
      const issued = String(Date.now());
      res.writeHead(303, {
        "Set-Cookie": `${COOKIE}=${issued}.${sign(issued)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${MAX_AGE_S}`,
        Location: "/",
        "Referrer-Policy": "no-referrer",
        "Cache-Control": "no-store",
      });
      return res.end();
    }

    if (!signedIn(req)) return notFound(res);

    if (path === "/") return serveConsole(res);
    if (path.startsWith("/api/")) {
      if (!sameOrigin(req)) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        return res.end("Cross-site request refused");
      }
      return proxy(req, res);
    }
    res.writeHead(302, { Location: SITE + req.url });
    res.end();
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
}).listen(PORT, () => console.log(`console on :${PORT} -> ${GATE}`));
