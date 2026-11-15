/**
 * The home door: the site on this Mac's home network, without Cloudflare.
 *
 * A small pass-through in front of the gate, listening on the LAN (compose
 * service `home-door`, port 3080). A device in the same flat (the TV app,
 * when it finds the door) loads the site from http://<this Mac>:3080 instead
 * of going out to Cloudflare and back. Everything is the gate's: the door
 * changes nothing on the way in except to say it came from home, and on the
 * way out only takes Secure off cookies and points redirects at itself
 * (home-door-rules.mjs says why).
 *
 * GET /__watch-home answers {"watch":"home","site":PUBLIC_URL} without
 * touching the gate, so the app can find the door by asking each address on
 * its network and know which site it belongs to.
 *
 * Zero dependencies; runs from the worker image (node:22).
 */
import http from "node:http";

import { HELLO_PATH, homeLocation, isHomeHost, relaxCookie } from "./home-door-rules.mjs";

const PORT = Number(process.env.HOME_DOOR_PORT ?? 3080);
const UPSTREAM = new URL(process.env.HOME_DOOR_UPSTREAM ?? "http://gate:3000");
const PUBLIC_URL = String(process.env.PUBLIC_URL ?? "").replace(/\/+$/, "");

const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });

/** Hop-by-hop headers are the connection's, not the request's. */
const HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function clean(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!HOP.has(name.toLowerCase()) && value !== undefined) out[name] = value;
  }
  return out;
}

const server = http.createServer((req, res) => {
  if (!isHomeHost(req.headers.host)) {
    res.writeHead(421, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("This door is for the home network only.\n");
    return;
  }

  if (req.method === "GET" && req.url === HELLO_PATH) {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ watch: "home", site: PUBLIC_URL }));
    return;
  }

  const doorOrigin = `http://${req.headers.host}`;
  const headers = clean(req.headers);
  headers["x-forwarded-proto"] = "http";
  headers["x-forwarded-host"] = req.headers.host;
  const from = req.socket.remoteAddress ?? "";
  headers["x-forwarded-for"] = req.headers["x-forwarded-for"] ? `${req.headers["x-forwarded-for"]}, ${from}` : from;

  const upstream = http.request(
    {
      protocol: UPSTREAM.protocol,
      hostname: UPSTREAM.hostname,
      port: UPSTREAM.port,
      method: req.method,
      path: req.url,
      headers,
      agent,
    },
    (up) => {
      const out = clean(up.headers);
      if (out["set-cookie"]) out["set-cookie"] = [].concat(out["set-cookie"]).map(relaxCookie);
      if (out.location) out.location = homeLocation(out.location, PUBLIC_URL, doorOrigin);
      res.writeHead(up.statusCode ?? 502, up.statusMessage, out);
      up.pipe(res);
      up.on("error", () => res.destroy());
    },
  );

  upstream.on("error", (error) => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(`The site is not answering (${error.code ?? error.message}).\n`);
  });
  // A viewer who skips ahead drops a video request half-way: stop reading the
  // gate's answer too, rather than streaming the rest of the film to nobody.
  res.on("close", () => {
    if (!res.writableFinished) upstream.destroy();
  });
  req.pipe(upstream);
});

// A film can stream for hours on one response; the defaults would cut it.
server.requestTimeout = 0;
server.headersTimeout = 60_000;
server.keepAliveTimeout = 65_000;

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[home-door] listening on :${PORT}, passing to ${UPSTREAM.href} for ${PUBLIC_URL || "(PUBLIC_URL unset)"}`);
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
