#!/usr/bin/env node
/**
 * Watch-folder ingest worker.
 *
 *   node scripts/media-worker.mjs
 *
 * Drop a file into MEDIA_INCOMING. This converts anything a browser cannot
 * direct-play into 1080p H.264 + AAC MP4, moves the result into the Jellyfin
 * library, and asks Jellyfin to rescan. Files that already direct-play are
 * moved straight across without re-encoding.
 *
 * ---------------------------------------------------------------------------
 * WHY THE INCOMING FOLDER MUST NOT BE INSIDE THE JELLYFIN LIBRARY
 *
 * Jellyfin indexes a converted file sitting beside its source as a SECOND
 * movie with the same name — not as another version of the same one. Verified:
 * dropping "Catwoman ... [1080p].mp4" next to "Catwoman ... .mkv" produced two
 * separate "Catwoman: Hunted" entries in the catalogue.
 *
 * So the layout is three separate directories:
 *
 *   MEDIA_INCOMING   drop zone, invisible to Jellyfin
 *   MEDIA_LIBRARY    the only path Jellyfin is pointed at
 *   <incoming>/.processed/   originals, kept after a successful conversion
 *
 * Nothing is ever deleted. If a conversion goes wrong you still have the file.
 * ---------------------------------------------------------------------------
 *
 * Runs as its own process, writing to the same SQLite file as the gateway.
 * That is safe because the database is in WAL mode — the gateway keeps serving
 * pages while a conversion writes progress.
 */

import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  copyFileSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";

/* ------------------------------------------------------------------ *
 * Config
 * ------------------------------------------------------------------ */

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSyncSafe(path).split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function readFileSyncSafe(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

loadEnvFile(resolve(process.cwd(), ".env.local"));
loadEnvFile(resolve(process.cwd(), ".env"));

const abs = (p, fallback) => {
  const v = (p ?? "").trim() || fallback;
  return isAbsolute(v) ? v : resolve(process.cwd(), v);
};

const INCOMING = abs(process.env.MEDIA_INCOMING, "./media/incoming");
const LIBRARY = abs(process.env.MEDIA_LIBRARY, "./media/movies");
const PROCESSED = join(INCOMING, ".processed");  // legacy alias; see ARCHIVE
const DB_PATH = abs(process.env.DATABASE_PATH, "./data/jellyfin-gate.db");

const JELLYFIN_URL = (process.env.JELLYFIN_URL ?? "http://127.0.0.1:8096").replace(/\/+$/, "");
const JELLYFIN_API_KEY = process.env.JELLYFIN_API_KEY ?? "";
const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH ?? "ffprobe";

const POLL_SECONDS = Number(process.env.WATCH_POLL_SECONDS ?? 30);

/**
 * "queue" (default): touches nothing on its own. Drains whatever is already
 * sitting in media_jobs — rows the gate's admin dashboard inserted when an
 * admin explicitly clicked Transform on a specific file — then exits. No
 * folder watching, no library-wide auto-discovery, no daemon left running.
 *
 * "watch": the original always-on behaviour — watches MEDIA_INCOMING and
 * periodically walks the whole library queuing anything unplayable, for
 * anyone who wants the worker to run that way instead.
 */
const WORKER_MODE = (process.env.WORKER_MODE ?? "queue").trim().toLowerCase();

/**
 * Continuous library upgrade.
 *
 * The watch folder only ever sees NEW files. A library that predates this
 * worker — or one filled by any other route — keeps its 4K HEVC MKVs, and every
 * play of one costs a live transcode: measured at 2.3x realtime with a ~15s
 * penalty on every seek, against 0.55s for a file that direct-plays.
 *
 * So the worker also walks MEDIA_LIBRARY looking for anything a browser cannot
 * play, and converts it in place. Set LIBRARY_SCAN=false to turn this off.
 */
const LIBRARY_SCAN = !/^(0|false|no|off)$/i.test(process.env.LIBRARY_SCAN ?? "true");
const LIBRARY_SCAN_INTERVAL_MS =
  Number(process.env.LIBRARY_SCAN_INTERVAL_MINUTES ?? 60) * 60 * 1000;

/**
 * Where originals go once converted. MUST be outside MEDIA_LIBRARY: Jellyfin
 * indexes a converted file sitting next to its source as a SECOND movie of the
 * same name rather than another version of it.
 */
const ARCHIVE = abs(process.env.MEDIA_ARCHIVE, join(INCOMING, ".processed"));

/**
 * Never start a conversion while somebody is watching.
 *
 * Encoding and transcoding compete for the same cores, and a conversion running
 * against a live transcode is exactly how playback starts stuttering. Jellyfin
 * is asked what it is currently serving, and the worker simply waits.
 */
const PAUSE_WHILE_STREAMING =
  !/^(0|false|no|off)$/i.test(process.env.PAUSE_WHILE_STREAMING ?? "true");

/** x264 preset for the software fallback. */
const TRANSCODE_PRESET = process.env.TRANSCODE_PRESET ?? "veryfast";
/**
 * A file is only picked up once its size has been unchanged across two polls.
 * Without this the worker would happily start transcoding a half-copied file.
 */
const STABLE_POLLS = 2;

const MAX_WIDTH = 1920;

/**
 * Subtitle languages worth keeping, in preference order.
 *
 * These sources carry a lot: 43 tracks on Tetris, 29 on Barbie. Extracting all
 * of them makes an unusable picker and litters the folder, so the list is
 * narrowed to English plus the Indian languages this library is actually for.
 * The originals are archived intact, so a dropped track is never truly lost.
 */
const SUBTITLE_LANGUAGES = (process.env.SUBTITLE_LANGUAGES ??
  "eng,hin,tam,tel,ben,mar,kan,mal,guj,pan,urd")
  .split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);

/** ISO 639-2 -> the 2-letter codes Jellyfin reads from a filename suffix. */
const LANG_SHORT = {
  eng: "en", hin: "hi", tam: "ta", tel: "te", ben: "bn", mar: "mr",
  kan: "kn", mal: "ml", guj: "gu", pan: "pa", urd: "ur", ori: "or", asm: "as",
};

/**
 * Only text-based codecs can become .srt. PGS and VOBSUB are bitmap formats —
 * converting those needs OCR, which is a different project, so they are skipped
 * rather than silently producing empty files.
 */
const TEXT_SUBTITLE_CODECS = new Set([
  "subrip", "srt", "ass", "ssa", "mov_text", "webvtt", "text",
]);
const VIDEO_EXTENSIONS = new Set([
  ".mkv", ".mp4", ".avi", ".mov", ".m4v", ".webm", ".wmv", ".flv", ".mpg", ".mpeg", ".ts",
]);

/* ------------------------------------------------------------------ *
 * Database
 * ------------------------------------------------------------------ */

mkdirSync(INCOMING, { recursive: true });
mkdirSync(LIBRARY, { recursive: true });
mkdirSync(PROCESSED, { recursive: true });
mkdirSync(ARCHIVE, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA busy_timeout = 10000");
db.exec("PRAGMA foreign_keys = ON");

const log = (...args) => console.log(new Date().toISOString(), ...args);

/**
 * The gateway owns the schema. Under compose there is no ordering guarantee
 * between the two containers, so wait rather than exit — exiting turns a
 * few-seconds-early start into a restart loop that never resolves, because
 * `restart: unless-stopped` keeps racing the same way.
 */
async function waitForSchema() {
  const deadline = Date.now() + 120_000;
  let warned = false;
  for (;;) {
    // Every table this worker touches, not just media_jobs: a newer worker
    // paired with an older gateway would otherwise start, prepare a statement
    // against a table that does not exist yet, and crash-loop on "SQL logic
    // error" — which says nothing about the real cause.
    const ready = db
      .prepare(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('media_jobs','job_controls')",
      )
      .get();
    if (Number(ready?.n ?? 0) === 2) return;

    if (!warned) {
      log("waiting for the gateway to create the schema…");
      warned = true;
    }
    if (Date.now() > deadline) {
      console.error(
        `No media_jobs table in ${DB_PATH} after 2 minutes.\n` +
          "Start the gateway (or run `npm run db:init`) so the schema exists.",
      );
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
}

await waitForSchema();

/* ------------------------------------------------------------------ *
 * Probing
 * ------------------------------------------------------------------ */

function run(command, args) {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => resolveRun({ code: -1, stdout, stderr: String(err) }));
    child.on("close", (code) => resolveRun({ code, stdout, stderr }));
  });
}

async function probe(file) {
  const { code, stdout } = await run(FFPROBE, [
    "-v", "error",
    "-show_entries", "format=duration",
    "-select_streams", "v:0",
    "-show_entries", "stream=codec_name,width,height",
    "-of", "json",
    file,
  ]);
  if (code !== 0) return null;
  try {
    const data = JSON.parse(stdout);
    const stream = data.streams?.[0] ?? {};
    return {
      codec: stream.codec_name ?? null,
      width: Number(stream.width ?? 0),
      height: Number(stream.height ?? 0),
      duration: Number(data.format?.duration ?? 0),
    };
  } catch {
    return null;
  }
}

/**
 * Lists text subtitle streams worth extracting, in the configured language
 * preference order so the first English track ends up first.
 */
async function probeSubtitles(file) {
  const { code, stdout } = await run(FFPROBE, [
    "-v", "error",
    "-select_streams", "s",
    "-show_entries", "stream=index,codec_name:stream_tags=language,title:stream_disposition=forced,hearing_impaired",
    "-of", "json",
    file,
  ]);
  if (code !== 0) return [];

  let streams;
  try {
    streams = JSON.parse(stdout).streams ?? [];
  } catch {
    return [];
  }

  const wanted = [];
  streams.forEach((stream, order) => {
    const codec = (stream.codec_name ?? "").toLowerCase();
    if (!TEXT_SUBTITLE_CODECS.has(codec)) return;

    const lang = (stream.tags?.language ?? "und").toLowerCase();
    if (!SUBTITLE_LANGUAGES.includes(lang)) return;

    wanted.push({
      // Index within the subtitle streams only, which is what -map 0:s:N wants.
      subIndex: order,
      lang,
      short: LANG_SHORT[lang] ?? lang,
      forced: Boolean(stream.disposition?.forced),
      sdh: Boolean(stream.disposition?.hearing_impaired),
      title: stream.tags?.title ?? null,
    });
  });

  wanted.sort(
    (a, b) => SUBTITLE_LANGUAGES.indexOf(a.lang) - SUBTITLE_LANGUAGES.indexOf(b.lang),
  );
  return wanted;
}

/**
 * Writes each wanted track beside the converted video as a sidecar .srt.
 *
 * Sidecars rather than embedded tracks on purpose: Jellyfin indexes them as
 * external subtitles, the browser player can request them as plain files, and
 * adding or fixing one later does not mean re-muxing a 2 GB video.
 *
 * Naming follows Jellyfin's convention — "Movie.en.srt", plus .forced / .sdh
 * where the source flags it — so it picks up the language without being told.
 */
async function extractSubtitles(source, outputPath, tracks) {
  if (tracks.length === 0) return 0;

  const base = join(dirname(outputPath), basename(outputPath, extname(outputPath)));
  const args = ["-hide_banner", "-nostdin", "-y", "-i", source];
  const seen = new Map();
  const produced = [];

  for (const track of tracks) {
    // Several tracks can share a language (regular / forced / SDH). Suffix the
    // duplicates so they do not overwrite each other.
    const parts = [track.short];
    if (track.forced) parts.push("forced");
    if (track.sdh) parts.push("sdh");
    let name = parts.join(".");
    const count = (seen.get(name) ?? 0) + 1;
    seen.set(name, count);
    if (count > 1) name = `${name}.${count}`;

    const target = `${base}.${name}.srt`;
    args.push("-map", `0:s:${track.subIndex}`, "-c:s", "srt", target);
    produced.push(target);
  }

  const { code, stderr } = await run(FFMPEG, args);
  if (code !== 0) {
    log(`  subtitle extraction failed: ${stderr.trim().split("\n").slice(-1)[0] ?? code}`);
    for (const file of produced) {
      try { if (existsSync(file)) unlinkSync(file); } catch { /* best effort */ }
    }
    return 0;
  }

  // ffmpeg happily writes a 0-byte file for a track that turns out empty.
  let kept = 0;
  for (const file of produced) {
    try {
      if (existsSync(file) && statSync(file).size > 0) kept += 1;
      else if (existsSync(file)) unlinkSync(file);
    } catch { /* best effort */ }
  }
  return kept;
}

/** Matches the DirectPlayProfiles the gateway advertises to browsers. */
function alreadyPlayable(file, info) {
  const ext = extname(file).toLowerCase();
  return (
    (ext === ".mp4" || ext === ".m4v") &&
    info.codec === "h264" &&
    info.width > 0 &&
    info.width <= MAX_WIDTH
  );
}

/* ------------------------------------------------------------------ *
 * Job records
 * ------------------------------------------------------------------ */

/**
 * Everything up to the first release-quality marker.
 *
 * Scene filenames are consistently "Title.Year.<noise>", so truncating at the
 * first noise token is far more reliable than trying to delete each token: a
 * subtractive approach leaves debris behind, because "AAC5.1" becomes "AAC5 1"
 * once dots are spaces and the trailing "1" survives. That produced the title
 * "Tetris 2023 1", which would then have become the output filename and fed
 * Jellyfin a title it could not match.
 *
 * The output is named "Title (Year).mp4" — Jellyfin's own preferred convention,
 * which gives its metadata matcher the best chance.
 */
const RELEASE_MARKER =
  /\b(1080p|2160p|1440p|720p|480p|4k|uhd|web[- ]?dl|webrip|web|bluray|blu[- ]?ray|brrip|bdrip|dvdrip|hdrip|hdtv|x264|x265|h ?264|h ?265|hevc|avc|aac\d*|ac3|eac3|dts(?:[- ]?hd)?|truehd|ddp?\d*|10bit|8bit|hdr\d*|remux|proper|repack|extended|imax)\b/i;

function parseName(file) {
  const raw = basename(file, extname(file)).replace(/[._]/g, " ");

  const cut = raw.search(RELEASE_MARKER);
  let title = (cut > 0 ? raw.slice(0, cut) : raw).trim();

  // Pull the year out so it can be re-attached in Jellyfin's preferred form.
  let year = null;
  const yearMatch = title.match(/\b((?:19|20)\d{2})\b/);
  if (yearMatch) {
    year = yearMatch[1];
    title = title.slice(0, yearMatch.index).trim();
  }

  title = title
    .replace(/\[[^\]]*\]|\([^)]*\)/g, "")
    .replace(/\s{2,}/g, " ")
    // Trailing brackets too: slicing a parenthesised year off "The Matrix (1999)"
    // leaves a dangling "(" behind.
    .replace(/[-–([{\s]+$/, "")
    .trim();

  if (!title) title = basename(file, extname(file));
  return { title, year };
}

function titleFrom(file) {
  const { title, year } = parseName(file);
  return year ? `${title} (${year})` : title;
}

const insertJob = db.prepare(
  `INSERT OR IGNORE INTO media_jobs (id, source_path, title, status, progress, created_at, bytes_in)
   VALUES (?, ?, ?, 'pending', 0, ?, ?)`,
);
const claimJob = db.prepare(
  "UPDATE media_jobs SET status = 'running', started_at = ? WHERE id = ? AND status = 'pending'",
);
const setProgress = db.prepare(
  "UPDATE media_jobs SET progress = ?, speed = ? WHERE id = ?",
);
const finishJob = db.prepare(
  `UPDATE media_jobs SET status = ?, output_path = ?, bytes_out = ?, error = ?,
          progress = ?, finished_at = ? WHERE id = ?`,
);

/**
 * Writes straight into the gate app's event_log table (see src/lib/events.ts
 * for the reader side) — this process has its own DatabaseSync handle on the
 * same WAL-mode file, so no IPC is needed to keep worker failures in the same
 * unified feed the dashboard reads for everything else. Never throws: a
 * failed log write must not be the reason a real failure goes unrecorded in
 * media_jobs, which already has its own `error` column as the source of truth.
 */
const insertEvent = db.prepare(
  `INSERT INTO event_log (id, category, severity, source, message, detail, item_id, username, created_at)
   VALUES (?, 'media_job', 'error', 'worker', ?, ?, NULL, NULL, ?)`,
);
function logWorkerFailure(message, detail) {
  try {
    insertEvent.run(randomUUID(), message.slice(0, 2000), JSON.stringify(detail ?? {}).slice(0, 4000), Date.now());
  } catch (err) {
    log("event log write failed:", err.message);
  }
}
/**
 * Pause is implemented with SIGSTOP/SIGCONT rather than by killing ffmpeg.
 *
 * There is no mid-file resume: a killed conversion restarts from zero, which on
 * a two-hour encode is the difference between an inconvenience and losing an
 * afternoon. Suspending the process keeps every frame already done.
 */
const readControl = db.prepare("SELECT action FROM job_controls WHERE job_id = ?");
const clearControl = db.prepare("DELETE FROM job_controls WHERE job_id = ?");
const setStatus = db.prepare("UPDATE media_jobs SET status = ? WHERE id = ?");

const nextPending = db.prepare(
  "SELECT * FROM media_jobs WHERE status = 'pending' ORDER BY created_at LIMIT 1",
);
const knownPaths = db.prepare("SELECT source_path FROM media_jobs");

/**
 * Anything left as 'running' at startup belonged to a previous process that was
 * killed mid-convert. Put it back in the queue rather than leaving a card stuck
 * at 40% forever.
 */
// A paused job is also stale after a restart — the suspended process is gone,
// so it goes back in the queue rather than sitting "paused" forever.
const requeued = db
  .prepare("UPDATE media_jobs SET status = 'pending', progress = 0, started_at = NULL WHERE status IN ('running', 'paused')")
  .run();
if (Number(requeued.changes) > 0) {
  log(`re-queued ${requeued.changes} job(s) interrupted by a previous shutdown`);
}

/* ------------------------------------------------------------------ *
 * Scanning
 * ------------------------------------------------------------------ */

const sizeHistory = new Map();

/** True when this path lives inside the published library. */
function isLibraryPath(file) {
  return file === LIBRARY || file.startsWith(LIBRARY + "/");
}

/** Recursively lists video files, skipping dot-directories and the archive. */
function walkVideos(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  // Jellyfin skips any folder containing a `.ignore` file; honour the same
  // convention so personal footage kept out of the catalogue does not get
  // silently transcoded and renamed by this worker.
  if (existsSync(join(dir, ".ignore"))) return out;

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (full === ARCHIVE || full === INCOMING) continue;
    if (entry.isDirectory()) {
      walkVideos(full, out);
    } else if (entry.isFile() && VIDEO_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Files already checked and found fine, keyed by path -> mtime+size. Avoids
 * re-probing an unchanged library on every pass; ffprobe is cheap per file but
 * not free across hundreds of them.
 */
const knownGood = new Map();
let lastLibraryScan = 0;

async function scanLibrary() {
  if (!LIBRARY_SCAN) return;
  if (Date.now() - lastLibraryScan < LIBRARY_SCAN_INTERVAL_MS) return;
  lastLibraryScan = Date.now();

  const files = walkVideos(LIBRARY);
  const known = new Set(knownPaths.all().map((r) => r.source_path));
  let queued = 0;
  let checked = 0;

  for (const file of files) {
    if (known.has(file)) continue;

    let stat;
    try {
      stat = statSync(file);
    } catch {
      continue;
    }
    const fingerprint = `${stat.mtimeMs}:${stat.size}`;
    if (knownGood.get(file) === fingerprint) continue;

    checked += 1;
    const info = await probe(file);
    if (!info) continue;

    if (alreadyPlayable(file, info)) {
      knownGood.set(file, fingerprint);
      continue;
    }

    insertJob.run(randomUUID(), file, titleFrom(file), Date.now(), stat.size);
    queued += 1;
    log(`queued from library: ${basename(file)}`);
  }

  if (checked > 0 || queued > 0) {
    log(`library scan: ${files.length} file(s), ${checked} probed, ${queued} queued`);
  }
}

/**
 * Asks Jellyfin whether anything is playing. Returns false if it cannot tell —
 * failing open, because a broken status check should not stop the queue
 * forever.
 */
async function someoneIsWatching() {
  if (!PAUSE_WHILE_STREAMING || !JELLYFIN_API_KEY) return false;
  try {
    const response = await fetch(`${JELLYFIN_URL}/Sessions`, {
      headers: { Authorization: `MediaBrowser Token="${JELLYFIN_API_KEY}"` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return false;
    const sessions = await response.json();
    return sessions.some((session) => session.NowPlayingItem);
  } catch {
    return false;
  }
}

function scanIncoming() {
  let entries;
  try {
    entries = readdirSync(INCOMING, { withFileTypes: true });
  } catch (error) {
    log("cannot read incoming folder:", error.message);
    return;
  }

  const known = new Set(
    knownPaths.all().map((r) => r.source_path),
  );

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ext = extname(entry.name).toLowerCase();
    if (!VIDEO_EXTENSIONS.has(ext)) continue;
    if (entry.name.startsWith(".")) continue;

    const full = join(INCOMING, entry.name);
    if (known.has(full)) continue;

    let size;
    try {
      size = statSync(full).size;
    } catch {
      continue;
    }

    const previous = sizeHistory.get(full);
    if (previous === undefined || previous.size !== size) {
      // Still growing, or seen for the first time. Wait for the next poll.
      sizeHistory.set(full, { size, stable: 0 });
      continue;
    }

    const stable = previous.stable + 1;
    sizeHistory.set(full, { size, stable });
    if (stable < STABLE_POLLS) continue;

    insertJob.run(randomUUID(), full, titleFrom(entry.name), Date.now(), size);
    sizeHistory.delete(full);
    log(`queued: ${entry.name}`);
  }
}

/* ------------------------------------------------------------------ *
 * Conversion
 * ------------------------------------------------------------------ */

let hardwareEncode = null;

async function detectHardware() {
  if (hardwareEncode !== null) return hardwareEncode;
  hardwareEncode = false;
  if (!existsSync("/dev/dri/renderD128")) return hardwareEncode;

  // Captured rather than piped into grep: under a shell with pipefail, grep -q
  // exits on first match and ffmpeg takes SIGPIPE, which reads as failure.
  const { stdout } = await run(FFMPEG, ["-hide_banner", "-encoders"]);
  if (!stdout.includes("h264_vaapi")) return hardwareEncode;

  const test = await run(FFMPEG, [
    "-hide_banner", "-loglevel", "error",
    "-vaapi_device", "/dev/dri/renderD128",
    "-f", "lavfi", "-i", "testsrc=duration=0.1:size=320x240:rate=5",
    "-vf", "format=nv12,hwupload", "-c:v", "h264_vaapi", "-f", "null", "-",
  ]);
  hardwareEncode = test.code === 0;
  return hardwareEncode;
}

function uniqueOutputPath(title) {
  const safe = title.replace(/[/\\:*?"<>|]/g, "").trim() || "Untitled";
  let candidate = join(LIBRARY, `${safe}.mp4`);
  let n = 2;
  while (existsSync(candidate)) {
    candidate = join(LIBRARY, `${safe} (${n}).mp4`);
    n += 1;
  }
  return candidate;
}

async function convert(job, info) {
  const useHw = await detectHardware();
  const output = uniqueOutputPath(job.title);
  // Written as a hidden .mp4 so a crash cannot leave a half-file for Jellyfin
  // to index as a broken title — it skips dotfiles — and so ffmpeg can still
  // infer the muxer from the extension. An earlier "<name>.mp4.part" failed
  // outright with "Unable to find a suitable output format".
  const temp = join(LIBRARY, `.${basename(output, ".mp4")}.inprogress.mp4`);

  // format=yuv420p is not cosmetic. These sources are 10-bit HEVC, and libx264
  // with `-profile:v high` cannot encode 10-bit — it fails outright with
  // "Error while opening encoder", zero frames written. Browsers want 8-bit
  // H.264 anyway. The hardware path gets nv12, which is 8-bit by definition.
  const scale = useHw
    ? `scale=w=min(${MAX_WIDTH}\\,iw):h=-2,format=nv12,hwupload`
    : `scale=w=min(${MAX_WIDTH}\\,iw):h=-2,format=yuv420p`;

  const videoArgs = useHw
    ? ["-c:v", "h264_vaapi", "-qp", "22"]
    : ["-c:v", "libx264", "-preset", TRANSCODE_PRESET, "-crf", "21", "-profile:v", "high", "-level", "4.1"];

  const args = [
    "-hide_banner", "-nostdin", "-y",
    ...(useHw ? ["-vaapi_device", "/dev/dri/renderD128"] : []),
    "-i", job.source_path,
    "-vf", scale,
    ...videoArgs,
    "-maxrate", "6M", "-bufsize", "12M",
    "-c:a", "aac", "-ac", "2", "-b:a", "192k",
    "-movflags", "+faststart",
    // Explicit muxer, so the temp filename can never change the output format.
    "-f", "mp4",
    // No subtitles in the video stream itself. They are extracted separately
    // into sidecar .srt files after the encode — see extractSubtitles. Burning
    // them in would make them permanent and unselectable.
    "-sn",
    "-progress", "pipe:1", "-nostats",
    temp,
  ];

  log(`converting "${job.title}" (${useHw ? "VAAPI" : "software"})`);

  return new Promise((resolveConvert) => {
    const child = spawn(FFMPEG, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let buffer = "";
    let suspended = false;

    // Watches for a pause/resume request raised by the UI or the admin API.
    const control = setInterval(() => {
      let action;
      try {
        action = readControl.get(job.id)?.action;
      } catch {
        return;
      }
      if (!action) return;

      try {
        if (action === "pause" && !suspended) {
          process.kill(child.pid, "SIGSTOP");
          suspended = true;
          setStatus.run("paused", job.id);
          log(`paused "${job.title}"`);
          clearControl.run(job.id);
        } else if (action === "resume" && suspended) {
          process.kill(child.pid, "SIGCONT");
          suspended = false;
          setStatus.run("running", job.id);
          log(`resumed "${job.title}"`);
          clearControl.run(job.id);
        } else {
          clearControl.run(job.id);
        }
      } catch (error) {
        log(`control signal failed: ${error.message}`);
        clearControl.run(job.id);
      }
    }, 2000);

    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      let micros = null;
      let speed = null;
      for (const line of lines) {
        const [key, value] = line.split("=");
        // ffmpeg emits "out_time_us=N/A" and "speed=N/A" for the first few
        // updates, before it has processed enough to report. Number("N/A") is
        // NaN, which survives a `!== null` check and then binds as SQL NULL —
        // violating the NOT NULL on progress and killing the worker mid-convert.
        if (key === "out_time_us" || key === "out_time_ms") {
          const n = Number(value);
          micros = Number.isFinite(n) ? n : null;
        }
        if (key === "speed") {
          const n = Number.parseFloat(value);
          speed = Number.isFinite(n) ? n : null;
        }
      }
      if (micros !== null && info.duration > 0) {
        // ffmpeg's `out_time_ms` is actually microseconds, despite the name.
        const seconds = micros / 1_000_000;
        const percent = Math.max(0, Math.min(99, Math.round((seconds / info.duration) * 100)));
        if (Number.isFinite(percent)) setProgress.run(percent, speed, job.id);
      }
    });

    child.stderr.on("data", (d) => {
      stderr += d;
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });

    child.on("error", (err) => {
      clearInterval(control);
      resolveConvert({ ok: false, error: String(err), temp });
    });

    child.on("close", (code) => {
      clearInterval(control);
      if (code === 0 && existsSync(temp)) {
        resolveConvert({ ok: true, temp, output });
      } else {
        resolveConvert({
          ok: false,
          error: (stderr.trim().split("\n").slice(-3).join(" ") || `ffmpeg exited ${code}`).slice(0, 500),
          temp,
        });
      }
    });
  });
}

/** Moves a file, falling back to copy+unlink when crossing filesystems. */
function move(from, to) {
  try {
    renameSync(from, to);
  } catch (error) {
    if (error.code !== "EXDEV") throw error;
    copyFileSync(from, to);
    unlinkSync(from);
  }
}

/** Carries any sidecar subtitle files across with the video. */
function moveSidecars(sourcePath, outputPath) {
  const base = basename(sourcePath, extname(sourcePath));
  const outBase = basename(outputPath, extname(outputPath));
  const sourceDir = dirname(sourcePath);
  const targetDir = dirname(outputPath);
  let moved = 0;
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!/\.(srt|ass|ssa|vtt)$/i.test(entry.name)) continue;
    if (!entry.name.startsWith(base)) continue;
    const suffix = entry.name.slice(base.length);
    try {
      move(join(sourceDir, entry.name), join(targetDir, `${outBase}${suffix}`));
      moved += 1;
    } catch {
      /* a subtitle that will not move is not worth failing the job over */
    }
  }
  return moved;
}

async function refreshJellyfin() {
  if (!JELLYFIN_API_KEY) {
    log("JELLYFIN_API_KEY not set — skipping library refresh");
    return;
  }
  try {
    const response = await fetch(`${JELLYFIN_URL}/Library/Refresh`, {
      method: "POST",
      headers: { Authorization: `MediaBrowser Token="${JELLYFIN_API_KEY}"` },
      signal: AbortSignal.timeout(15_000),
    });
    log(`library refresh -> ${response.status}`);
  } catch (error) {
    log("library refresh failed:", error.message);
  }
}

async function processOne() {
  const job = nextPending.get();
  if (!job) return false;

  const claimed = claimJob.run(Date.now(), job.id);
  if (Number(claimed.changes) !== 1) return false;

  if (!existsSync(job.source_path)) {
    finishJob.run("failed", null, null, "Source file disappeared", 0, Date.now(), job.id);
    log(`missing source: ${job.source_path}`);
    return true;
  }

  const info = await probe(job.source_path);
  if (!info) {
    finishJob.run("failed", null, null, "Not a readable video file", 0, Date.now(), job.id);
    logWorkerFailure(`Unreadable file — likely corrupt or an unsupported container: "${job.title}"`, {
      title: job.title,
      sourcePath: job.source_path,
    });
    log(`unreadable: ${job.source_path}`);
    return true;
  }

  // Already browser-friendly. A library file is left exactly where it is;
  // only a drop-zone file needs relocating into the library.
  if (alreadyPlayable(job.source_path, info)) {
    if (isLibraryPath(job.source_path)) {
      finishJob.run("skipped", job.source_path, info ? statSync(job.source_path).size : null,
        null, 100, Date.now(), job.id);
      log(`already playable, left in place: ${job.title}`);
      return true;
    }
    const output = uniqueOutputPath(job.title);
    try {
      move(job.source_path, output);
      moveSidecars(job.source_path, output);
      finishJob.run("skipped", output, statSync(output).size, null, 100, Date.now(), job.id);
      log(`moved without re-encoding: ${job.title}`);
      await refreshJellyfin();
    } catch (error) {
      finishJob.run("failed", null, null, `Move failed: ${error.message}`, 0, Date.now(), job.id);
      logWorkerFailure(`Move failed for "${job.title}"`, { title: job.title, sourcePath: job.source_path, error: error.message });
    }
    return true;
  }

  const result = await convert(job, info);

  if (!result.ok) {
    try {
      if (existsSync(result.temp)) unlinkSync(result.temp);
    } catch { /* best effort */ }
    finishJob.run("failed", null, null, result.error, 0, Date.now(), job.id);
    logWorkerFailure(`Conversion failed for "${job.title}"`, { title: job.title, sourcePath: job.source_path, error: result.error });
    log(`FAILED "${job.title}": ${result.error}`);
    return true;
  }

  try {
    // A library file is replaced where it stands, so Jellyfin keeps finding the
    // title in the same folder. A file from the drop zone lands in the library
    // root. Either way the original leaves the library, which is what stops
    // Jellyfin indexing both as separate movies.
    const finalOutput = isLibraryPath(job.source_path)
      ? join(dirname(job.source_path), basename(result.output))
      : result.output;

    move(result.temp, finalOutput);
    let subs = moveSidecars(job.source_path, finalOutput);

    // Embedded tracks are extracted from the ORIGINAL, not the converted file:
    // the conversion drops them (-sn), and the original still has every track
    // at full fidelity.
    const tracks = await probeSubtitles(job.source_path);
    if (tracks.length > 0) {
      const extracted = await extractSubtitles(job.source_path, finalOutput, tracks);
      subs += extracted;
      log(`  subtitles: ${extracted} of ${tracks.length} wanted track(s) extracted`);
    }
    // The original is kept, never deleted — moved out of the library so it is
    // not picked up again and cannot be indexed alongside its replacement.
    move(job.source_path, join(ARCHIVE, basename(job.source_path)));
    result.output = finalOutput;

    const outSize = statSync(result.output).size;
    finishJob.run("done", result.output, outSize, null, 100, Date.now(), job.id);
    log(
      `done "${job.title}": ${(job.bytes_in / 1e9).toFixed(2)}GB -> ${(outSize / 1e9).toFixed(2)}GB` +
        (subs ? ` (+${subs} subtitle file(s))` : ""),
    );
    await refreshJellyfin();
  } catch (error) {
    finishJob.run("failed", null, null, `Publish failed: ${error.message}`, 0, Date.now(), job.id);
    logWorkerFailure(`Publish failed for "${job.title}"`, { title: job.title, sourcePath: job.source_path, error: error.message });
    log(`publish failed for "${job.title}": ${error.message}`);
  }

  return true;
}

/* ------------------------------------------------------------------ *
 * Main loop
 * ------------------------------------------------------------------ */

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    log(`${signal} received — finishing current step then exiting`);
    stopping = true;
  });
}

log(`mode       ${WORKER_MODE}`);
log(`publishing ${LIBRARY}`);
log(`originals  ${ARCHIVE}`);
log(`database   ${DB_PATH}`);

if (WORKER_MODE === "watch") {
  log(`watching   ${INCOMING}`);
  log(`library    ${LIBRARY} (scan ${LIBRARY_SCAN ? "on" : "off"}, every ${LIBRARY_SCAN_INTERVAL_MS / 60000}m)`);

  while (!stopping) {
    scanIncoming();
    await scanLibrary();

    if (await someoneIsWatching()) {
      log("someone is watching — deferring conversions");
      await new Promise((r) => setTimeout(r, POLL_SECONDS * 1000));
      continue;
    }

    // Strictly one conversion at a time. Two parallel ffmpeg jobs on a
    // four-thread box make both of them slower than running them in sequence,
    // and starve the transcoder serving anyone actually watching.
    let worked = await processOne();
    while (worked && !stopping) {
      worked = await processOne();
    }

    if (stopping) break;
    await new Promise((r) => setTimeout(r, POLL_SECONDS * 1000));
  }

  db.close();
  log("stopped");
} else {
  // Queue-only: touch nothing that wasn't explicitly queued (by the gate's
  // Transform button), then exit. No folder watching, no library-wide
  // auto-discovery — this is what "the worker never runs on its own" means
  // in practice, short of never starting the container at all.
  let queued = nextPending.get() !== undefined;
  if (!queued) {
    log("nothing queued — exiting");
  }

  let worked = await processOne();
  while (worked && !stopping) {
    if (await someoneIsWatching()) {
      log("someone is watching — deferring conversions");
      await new Promise((r) => setTimeout(r, POLL_SECONDS * 1000));
      continue;
    }
    worked = await processOne();
  }

  db.close();
  log(stopping ? "stopped" : "queue drained — exiting");
}
