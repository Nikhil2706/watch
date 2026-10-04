// Keeps the curator console reachable on the home Wi-Fi after a restart.
//
// The console runs inside WSL and is published on this PC's localhost:3200.
// Other devices reach it at <this PC's Wi-Fi address>:3200 through a Windows
// "portproxy" (see open-console-on-wifi.ps1). That forward belongs to a
// Windows service which tries to take the address once, at boot; when the
// Wi-Fi is not up yet it fails and does not try again, and the console is
// unreachable from the phone until someone restarts the service as
// administrator.
//
// This is the fallback, and needs no administrator: every 20 seconds, if
// nothing is listening on the Wi-Fi address, it takes the port itself and
// passes connections to localhost:3200. When Windows' own forward is working
// the port is taken and this simply waits. Started hidden at logon by the
// JellyfinGateConsoleForward scheduled task (console-forward.vbs).
//
// The firewall rule from open-console-on-wifi.ps1 (port 3200, Private
// networks, local subnet only) is what lets other devices in, for either
// forward; this opens nothing by itself.
"use strict";
const net = require("net");
const os = require("os");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.CONSOLE_FORWARD_PORT || 3200);
const TARGET_PORT = Number(process.env.CONSOLE_FORWARD_TARGET_PORT || 3200);
const FIXED_ADDRESS = process.env.CONSOLE_FORWARD_ADDRESS || null; // for testing
const LOG = path.join(__dirname, "console-forward.log");

function log(message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  try {
    // Small on purpose: start over rather than grow for ever.
    if (fs.existsSync(LOG) && fs.statSync(LOG).size > 200000) fs.writeFileSync(LOG, "");
    fs.appendFileSync(LOG, line);
  } catch (_) {
    /* a log that cannot be written is not worth stopping for */
  }
}

/** This PC's address on the Wi-Fi adapter, or null while the Wi-Fi is down. */
function wifiAddress() {
  if (FIXED_ADDRESS) return FIXED_ADDRESS;
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    if (!/^wi-?fi/i.test(name)) continue;
    const v4 = (nets[name] || []).find((a) => a.family === "IPv4" && !a.internal);
    if (v4) return v4.address;
  }
  return null;
}

let server = null;
let boundTo = null;
let lastState = "";

function say(state) {
  if (state !== lastState) log(state);
  lastState = state;
}

function release() {
  if (server) {
    try { server.close(); } catch (_) { /* already closed */ }
  }
  server = null;
  boundTo = null;
}

function tick() {
  const address = wifiAddress();
  if (!address) {
    release();
    say("Wi-Fi has no address yet; waiting");
    return;
  }
  if (server && boundTo === address) return;
  if (server && boundTo !== address) release(); // the Wi-Fi address changed

  const attempt = net.createServer((client) => {
    const upstream = net.connect(TARGET_PORT, "127.0.0.1");
    const drop = () => { client.destroy(); upstream.destroy(); };
    client.on("error", drop);
    upstream.on("error", drop);
    client.pipe(upstream);
    upstream.pipe(client);
  });
  attempt.on("error", (error) => {
    if (error.code === "EADDRINUSE") say(`${address}:${PORT} is already served (Windows' own forward is working); standing by`);
    else say(`cannot listen on ${address}:${PORT}: ${error.code || error.message}`);
    if (server === attempt) release();
  });
  attempt.listen({ host: address, port: PORT, exclusive: true }, () => {
    server = attempt;
    boundTo = address;
    say(`forwarding ${address}:${PORT} to localhost:${TARGET_PORT}`);
  });
}

log("started");
tick();
setInterval(tick, 20000);
