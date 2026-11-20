import "server-only";

import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { APP_APK_URL, APP_MANIFEST_URL } from "./app-release";
import { parseDescriptor, type Descriptor } from "./app-mirror-rules";
import { env } from "./env";

/**
 * A copy of the latest Android app, kept on this server, so phones and TVs
 * can update from the site instead of GitHub.
 *
 * On 2026-11-21 the Mi TV sat on 1.8.17 for weeks: the in-app updater
 * downloads from GitHub, and on the owner's line github.com took 15 s to
 * answer and the APK came at 8-38 KB/s while everything else ran at ~1.2 MB/s.
 * The server fetches the release in the background, where slow costs nobody
 * anything; the app asks the site first (and at home the site is the Mac on
 * the LAN, through the home door) and GitHub only if the site has nothing.
 *
 * Refreshed when asked and the copy is more than REFRESH_MS old; one refresh
 * at a time. Until a copy exists the descriptor route answers 503 and the app
 * falls back to GitHub.
 */

const DIR = join(dirname(env.databasePath), "app-mirror");
const APK = join(DIR, "watch-release.apk");
const META = join(DIR, "latest.json");
const REFRESH_MS = 30 * 60 * 1000;

export interface Mirrored extends Descriptor {
  size: number;
  fetchedAt: number;
}

let refreshing: Promise<void> | null = null;
let checkedAt = 0;

/** The mirrored release, or null when there is none yet. Starts a refresh if it is due. */
export async function mirroredRelease(): Promise<Mirrored | null> {
  if (Date.now() - checkedAt > REFRESH_MS) void refresh();
  return readMeta();
}

/** Where the mirrored APK is, with its size; null when there is none. */
export async function mirroredApk(): Promise<{ path: string; size: number } | null> {
  const meta = await readMeta();
  if (!meta) return null;
  try {
    const s = await stat(APK);
    return s.size === meta.size ? { path: APK, size: s.size } : null;
  } catch {
    return null;
  }
}

async function readMeta(): Promise<Mirrored | null> {
  try {
    const m = JSON.parse(await readFile(META, "utf8")) as Mirrored;
    return Number.isInteger(m.versionCode) && Number.isInteger(m.size) ? m : null;
  } catch {
    return null;
  }
}

function refresh(): Promise<void> {
  if (refreshing) return refreshing;
  checkedAt = Date.now();
  refreshing = (async () => {
    try {
      const res = await fetch(APP_MANIFEST_URL, { redirect: "follow", signal: AbortSignal.timeout(60_000), cache: "no-store" });
      if (!res.ok) throw new Error(`latest.json: HTTP ${res.status}`);
      const latest = parseDescriptor(await res.text());
      if (!latest) throw new Error("latest.json is not a release descriptor");
      const have = await readMeta();
      if (have && have.versionCode >= latest.versionCode && (await mirroredApk())) return;

      await mkdir(DIR, { recursive: true });
      const part = `${APK}.part`;
      // Slow on this line (minutes for 4 MB): nobody is waiting on it.
      const apk = await fetch(APP_APK_URL, { redirect: "follow", signal: AbortSignal.timeout(30 * 60_000), cache: "no-store" });
      if (!apk.ok || !apk.body) throw new Error(`APK: HTTP ${apk.status}`);
      const expected = Number(apk.headers.get("content-length") ?? 0);
      await pipeline(Readable.fromWeb(apk.body as never), createWriteStream(part));
      const got = (await stat(part)).size;
      if (got < 1_000_000 || (expected > 0 && got !== expected)) {
        await rm(part, { force: true });
        throw new Error(`APK download incomplete (${got} of ${expected || "?"} bytes)`);
      }
      await rename(part, APK);
      const meta: Mirrored = { ...latest, size: got, fetchedAt: Date.now() };
      await writeFile(META, JSON.stringify(meta));
      console.log(`[app-mirror] mirrored ${latest.versionName} (${latest.versionCode}), ${got} bytes`);
    } catch (error) {
      console.warn("[app-mirror] refresh failed:", error instanceof Error ? error.message : error);
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}
