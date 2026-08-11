#!/usr/bin/env node
/**
 * One-shot Jellyfin bootstrap.
 *
 *   node scripts/bootstrap-jellyfin.mjs --url http://127.0.0.1:8096 \
 *        --admin mamnani --password 'something-long' --media /media
 *
 * A fresh Jellyfin refuses every API call until its setup wizard has been
 * completed, so a `docker compose up` alone leaves you with a server that
 * cannot be used. This performs the wizard, creates a movie library, and mints
 * the API key the gateway needs — the whole manual click-through, scripted, so
 * rebuilding the stack from empty volumes is repeatable.
 *
 * Prints JELLYFIN_API_KEY at the end. Put that in .env and restart the gate.
 *
 * Order matters and is not obvious: GET /Startup/User must be called before
 * POST /Startup/User, because the POST *updates* the default first user that
 * the GET materialises. Posting first returns 404.
 */

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
}

const BASE = (args.get("url") ?? "http://127.0.0.1:8096").replace(/\/+$/, "");
const ADMIN = args.get("admin") ?? "admin";
const PASSWORD = args.get("password");
const MEDIA = args.get("media") ?? "/media";
const LIBRARY = args.get("library") ?? "Movies";

if (!PASSWORD || PASSWORD.length < 8) {
  console.error("--password is required and must be at least 8 characters.");
  process.exit(1);
}

const CLIENT_AUTH =
  'MediaBrowser Client="bootstrap", Device="cli", DeviceId="jellyfin-gate-bootstrap", Version="1.0.0"';

async function call(path, { method = "GET", body, token } = {}) {
  const headers = {
    Authorization: token ? `MediaBrowser Token="${token}"` : CLIENT_AUTH,
    Accept: "application/json",
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`${method} ${path} -> ${response.status} ${text.slice(0, 300)}`);
  }

  const text = await response.text();
  return text.trim() === "" ? null : JSON.parse(text);
}

async function waitForServer() {
  process.stdout.write("Waiting for Jellyfin");
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const info = await call("/System/Info/Public");
      process.stdout.write("\n");
      return info;
    } catch {
      process.stdout.write(".");
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw new Error(`Jellyfin never became reachable at ${BASE}`);
}

const info = await waitForServer();
console.log(`Jellyfin ${info.Version} — "${info.ServerName}"`);

if (info.StartupWizardCompleted) {
  console.log("Startup wizard already completed; skipping to API key.");
} else {
  await call("/Startup/Configuration", {
    method: "POST",
    body: {
      UICulture: "en-US",
      MetadataCountryCode: args.get("country") ?? "IN",
      PreferredMetadataLanguage: "en",
    },
  });
  console.log("  · locale set");

  // Materialises the default first user. Skipping this makes the next call 404.
  await call("/Startup/User");
  await call("/Startup/User", {
    method: "POST",
    body: { Name: ADMIN, Password: PASSWORD },
  });
  console.log(`  · admin user "${ADMIN}" created`);

  await call("/Startup/RemoteAccess", {
    method: "POST",
    body: { EnableRemoteAccess: true, EnableAutomaticPortMapping: false },
  });
  await call("/Startup/Complete", { method: "POST" });
  console.log("  · wizard completed");
}

const auth = await call("/Users/AuthenticateByName", {
  method: "POST",
  body: { Username: ADMIN, Pw: PASSWORD },
});
const token = auth.AccessToken;
console.log(`  · authenticated as ${auth.User.Name}`);

const libraries = await call("/Library/VirtualFolders", { token });
if (libraries.some((l) => l.Name === LIBRARY)) {
  console.log(`  · library "${LIBRARY}" already exists`);
} else {
  const query = new URLSearchParams({
    name: LIBRARY,
    collectionType: "movies",
    refreshLibrary: "true",
  });
  await call(`/Library/VirtualFolders?${query}`, {
    method: "POST",
    token,
    body: {
      LibraryOptions: {
        PathInfos: [{ Path: MEDIA }],
        EnableRealtimeMonitor: false,
        PreferredMetadataLanguage: "en",
      },
    },
  });
  console.log(`  · library "${LIBRARY}" created at ${MEDIA}`);
}

// Reuse an existing key rather than piling up a new one on every run.
const keys = await call("/Auth/Keys", { token });
let apiKey = keys?.Items?.find((k) => k.AppName === "jellyfin-gate")?.AccessToken;

if (!apiKey) {
  await call("/Auth/Keys?App=jellyfin-gate", { method: "POST", token });
  const refreshed = await call("/Auth/Keys", { token });
  apiKey = refreshed.Items.find((k) => k.AppName === "jellyfin-gate")?.AccessToken;
}

if (!apiKey) {
  console.error("Could not create the API key.");
  process.exit(1);
}

console.log("\nLibrary scan is running in the background.\n");
console.log("Add this to your .env, then `docker compose up -d gate`:\n");
console.log(`JELLYFIN_API_KEY=${apiKey}`);
