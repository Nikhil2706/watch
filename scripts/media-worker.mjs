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
  utimesSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";

import { countErrors, isStale, isStillArriving, judge } from "./file-check.mjs";
import { mp4SubtitlesBlock, needsBrowserAudio, remuxArgs, remuxReadsAsWell, verifyRemux } from "./browser-audio.mjs";
import { clamavScanner, scanWaitingUploads, writeHeartbeat } from "./upload-scan.mjs";
import { backupStamp, runBackup, snapshotDatabase } from "./backup.mjs";
import { failInterruptedWorkerRuns, recordLoopRun, runWorkerJobs } from "./worker-jobs.mjs";
import { alassArgs, judgeResult } from "./subtitle-autosync.mjs";

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
 * Where prepared offline-download files land — outside the library for the
 * same reason ARCHIVE is: Jellyfin must never index this, it's a cache the
 * download route (src/app/api/download/[itemId]/route.ts) serves from
 * directly, keyed one file per title (see download_jobs in schema.ts).
 */
const DOWNLOADS_CACHE = abs(process.env.MEDIA_DOWNLOADS_CACHE, "./media/downloads-cache");

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

{
  const cut = failInterruptedWorkerRuns(db);
  if (cut > 0) log(`${cut} job run(s) were cut off when the worker last stopped`);
}

/* ------------------------------------------------------------------ *
 * Reading files through for damage
 * ------------------------------------------------------------------ */

/**
 * The file check (see file-check.mjs for what it looks for, and why).
 *
 * Done here because this is the container with ffmpeg and the library, and
 * because the worker already knows to stand aside while someone is watching.
 * It is the lowest thing on the list: only once the conversion and download
 * queues are empty, a few minutes at a time, at low priority, and it stops
 * between files the moment anyone starts a film.
 *
 * Newest files first, so something added today is checked today. The rest of
 * the library is worked through at a set pace, 100 files a day by default
 * (FILE_CHECK_PER_DAY): reading 1,800 films end to end is hours of disk and
 * processor, and there is no hurry that is worth the machine being busy all
 * day for. A file added or changed in the last two days does not wait for
 * the day's allowance. A file is checked once; it is checked again only if
 * its size or date changes (it was replaced) or the curator asks.
 */
const FILE_CHECK = !/^(0|false|no|off)$/i.test(process.env.FILE_CHECK ?? "true");
const FILE_CHECK_BUDGET_MS = Number(process.env.FILE_CHECK_BUDGET_MINUTES ?? 4) * 60 * 1000;
const FILE_CHECK_TIMEOUT_MS = 15 * 60 * 1000;
const FILE_CHECK_PER_DAY = Number(process.env.FILE_CHECK_PER_DAY ?? 100);
const FILE_CHECK_NEW_MS = 2 * 24 * 60 * 60 * 1000;
// With nothing left to check, the library is only walked again this often.
const FILE_CHECK_IDLE_MS = 20 * 60 * 1000;
const WALK_MARK = "::last-walk";

function fileChecksReady() {
  return Boolean(db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='file_checks'").get());
}

function runQuietly(command, args, timeoutMs) {
  return new Promise((resolveRun) => {
    const child = spawn("nice", ["-n", "15", command, ...args], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    // A badly broken file can say the same thing a hundred thousand times.
    child.stderr.on("data", (d) => {
      if (stderr.length < 8_000_000) stderr += d;
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolveRun({ code: -1, stderr: String(err), timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveRun({ code, stderr, timedOut });
    });
  });
}

/**
 * Reads a file through and counts what ffmpeg could not read: the file
 * check's reading, also used on a browser-audio remux before it is swapped in.
 * Null when it took too long, which is not the same as broken.
 */
async function readThrough(file) {
  // Sound: decoded in full. Picture: every packet read, none decoded.
  const audio = await runQuietly(FFMPEG, ["-v", "error", "-i", file, "-map", "0:a:0?", "-f", "null", "-"], FILE_CHECK_TIMEOUT_MS);
  const video = await runQuietly(FFMPEG, ["-v", "error", "-i", file, "-map", "0:v:0", "-c", "copy", "-f", "null", "-"], FILE_CHECK_TIMEOUT_MS);
  if (audio.timedOut || video.timedOut) return null;
  return {
    audioErrors: countErrors(audio.stderr),
    videoErrors: countErrors(video.stderr),
    // ffmpeg could not open it at all (and said so, which is what tells this
    // from a file with no picture track).
    unreadable:
      video.code !== 0 && audio.code !== 0 && /Error opening input|moov atom not found/i.test(video.stderr.slice(0, 2000)),
  };
}

async function checkFile(file, size, mtimeMs) {
  const read = await readThrough(file);
  // Too slow to finish is not the same as broken: leave it for another round.
  if (!read) return null;
  const { audioErrors, videoErrors, unreadable } = read;
  const { verdict, detail } = judge({ audioErrors, videoErrors, unreadable });
  db.prepare(
    `INSERT INTO file_checks (path, size, mtime_ms, checked_at, audio_errors, video_errors, verdict, detail, allowed)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
     ON CONFLICT(path) DO UPDATE SET
       size = excluded.size, mtime_ms = excluded.mtime_ms, checked_at = excluded.checked_at,
       audio_errors = excluded.audio_errors, video_errors = excluded.video_errors,
       verdict = excluded.verdict, detail = excluded.detail, allowed = 0`,
  ).run(file, size, Math.round(mtimeMs), Date.now(), audioErrors, videoErrors, verdict, detail);
  return verdict;
}

/**
 * Checks files for up to the time budget. Returns a line for the Health tab,
 * or null when it read nothing.
 */
async function checkFilesForAWhile() {
  if (!FILE_CHECK || !fileChecksReady()) return null;
  const mark = db.prepare("SELECT mtime_ms FROM file_checks WHERE path = ?").get(WALK_MARK);
  // mtime_ms on the marker row is when the library is next worth walking:
  // set ahead when there was nothing left to do, or the day's allowance was
  // used, so an idle worker is not listing 1,800 files every half minute.
  if (mark && Date.now() < Number(mark.mtime_ms)) return null;

  const known = new Map(db.prepare("SELECT path, size, mtime_ms FROM file_checks").all().map((r) => [r.path, r]));
  const todo = [];
  const present = new Set();
  for (const file of walkVideos(LIBRARY)) {
    let stat;
    try {
      stat = statSync(file);
    } catch {
      continue;
    }
    present.add(file);
    if (isStillArriving(stat.mtimeMs, Date.now())) continue;
    if (isStale(known.get(file), stat.size, stat.mtimeMs)) todo.push({ file, size: stat.size, mtimeMs: stat.mtimeMs });
  }
  // A file that is gone needs no verdict kept.
  for (const path of known.keys()) {
    if (path !== WALK_MARK && !present.has(path)) db.prepare("DELETE FROM file_checks WHERE path = ?").run(path);
  }
  todo.sort((a, b) => b.mtimeMs - a.mtimeMs);

  // How much of today's allowance is left, counted over the last 24 hours.
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  let allowance =
    FILE_CHECK_PER_DAY -
    Number(db.prepare("SELECT COUNT(*) AS n FROM file_checks WHERE checked_at > ? AND path <> ?").get(dayAgo, WALK_MARK)?.n ?? 0);

  const started = Date.now();
  let done = 0;
  let damaged = 0;
  const damagedNames = [];
  let waiting = 0;
  for (const next of todo) {
    if (stopping || Date.now() - started > FILE_CHECK_BUDGET_MS) break;
    // A new file is checked whatever the day's count; the backlog waits.
    const isNew = Date.now() - next.mtimeMs < FILE_CHECK_NEW_MS;
    if (allowance <= 0 && !isNew) {
      waiting += 1;
      continue;
    }
    if (await someoneIsWatching()) break;
    allowance -= 1;
    const verdict = await checkFile(next.file, next.size, next.mtimeMs);
    if (verdict === null) continue;
    done += 1;
    if (verdict === "damaged") {
      damaged += 1;
      damagedNames.push(basename(next.file));
      log(`file check: DAMAGED ${next.file}`);
    }
  }
  const left = Math.max(0, todo.length - done);
  // Nothing left, or only files waiting for tomorrow's allowance: look again
  // in a while (which is also how soon a newly added file is noticed).
  const rest = left === 0 || waiting >= left ? Date.now() + FILE_CHECK_IDLE_MS : 0;
  db.prepare(
    `INSERT INTO file_checks (path, size, mtime_ms, checked_at, verdict) VALUES (?, ?, ?, ?, 'ok')
     ON CONFLICT(path) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms, checked_at = excluded.checked_at`,
  ).run(WALK_MARK, left, rest, Date.now());
  if (done === 0) return null;
  const line =
    `${done} read through, ${damaged} damaged${damagedNames.length ? ` (${damagedNames.slice(0, 5).join(", ")})` : ""}, ${left} still to do` +
    (allowance <= 0 ? ` (today's ${FILE_CHECK_PER_DAY} done)` : "");
  log(`file check: ${line}`);
  return line;
}

/* ------------------------------------------------------------------ *
 * Browser audio (scripts/browser-audio.mjs for the rules)
 * ------------------------------------------------------------------ *
 * A stereo AAC track added to films whose only sound a browser cannot play,
 * so Jellyfin stops re-encoding their audio live for every viewer. Same
 * habits as the damaged-file check: only when nothing is queued and nobody is
 * watching, a little at a time, each file looked at once (browser_audio
 * table) and again only if the file changes. Files the curator asked for
 * ("Add browser audio now") come first and don't count against the day.
 */
const BROWSER_AUDIO = !/^(0|false|no|off)$/i.test(process.env.BROWSER_AUDIO ?? "true");
const BROWSER_AUDIO_PER_DAY = Number(process.env.BROWSER_AUDIO_PER_DAY ?? 20);
/** Files probed per pass while working through the library the first time. */
const BROWSER_AUDIO_PROBES_PER_PASS = Number(process.env.BROWSER_AUDIO_PROBES_PER_PASS ?? 300);
const BROWSER_AUDIO_IDLE_MS = 30 * 60 * 1000;
const AUDIO_WALK_MARK = "::last-walk";

function browserAudioReady() {
  return Boolean(db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='browser_audio'").get());
}

/** Every stream, with what the audio rules need. Null when unreadable. */
async function probeStreams(file) {
  const { code, stdout } = await run(FFPROBE, [
    "-v", "error",
    "-show_entries", "format=duration:stream=index,codec_type,codec_name,channels,pix_fmt:stream_tags=language:stream_disposition=default",
    "-of", "json",
    file,
  ]);
  if (code !== 0) return null;
  try {
    const data = JSON.parse(stdout);
    return { format: data.format ?? {}, streams: data.streams ?? [] };
  } catch {
    return null;
  }
}

/** True while Jellyfin reports someone playing this very file. */
async function isBeingPlayed(file) {
  if (!JELLYFIN_API_KEY) return false;
  try {
    const response = await fetch(`${JELLYFIN_URL}/Sessions`, {
      headers: { Authorization: `MediaBrowser Token="${JELLYFIN_API_KEY}"` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return true; // can't tell: don't swap now
    const sessions = await response.json();
    return sessions.some((s) => s.NowPlayingItem?.Path === file);
  } catch {
    return true;
  }
}

function recordBrowserAudio(file, status, detail) {
  let size = 0;
  let mtimeMs = 0;
  try {
    const stat = statSync(file);
    size = stat.size;
    mtimeMs = Math.round(stat.mtimeMs);
  } catch { /* gone: recorded as last seen */ }
  db.prepare(
    `INSERT INTO browser_audio (path, size, mtime_ms, status, detail, checked_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms,
       status = excluded.status, detail = excluded.detail, checked_at = excluded.checked_at`,
  ).run(file, size, mtimeMs, status, detail, Date.now());
}

/**
 * Adds the track to one file if it needs one. Returns { status, detail }, or
 * null when it should simply be tried again later (someone started playing
 * it). Writes a hidden temp file beside the original (Jellyfin skips
 * dotfiles), checks it, and only then puts it in the original's place,
 * keeping the original's dates so nothing else thinks the film is new.
 */
async function addBrowserAudio(file) {
  const ext = extname(file);
  const before = await probeStreams(file);
  if (!before) return { status: "failed", detail: "the file can't be read" };
  const need = needsBrowserAudio(before.streams, ext);
  if (!need.needed) return { status: "not_needed", detail: need.reason };
  if (mp4SubtitlesBlock(before.streams, ext)) {
    return { status: "not_needed", detail: "an MP4 whose subtitles would not copy back into MP4" };
  }
  let original;
  try {
    original = statSync(file);
  } catch {
    return { status: "failed", detail: "the file disappeared" };
  }
  const temp = join(dirname(file), `.${basename(file, ext)}.browser-audio${ext}`);
  const cleanUp = () => {
    try {
      if (existsSync(temp)) unlinkSync(temp);
    } catch { /* best effort */ }
  };
  log(`browser audio: adding a stereo AAC track to ${basename(file)} (${need.reason})`);
  const result = await run(FFMPEG, remuxArgs(file, temp, before.streams, ext));
  if (result.code !== 0) {
    cleanUp();
    const why = result.stderr.trim().split("\n").slice(-1)[0] || `ffmpeg exited ${result.code}`;
    return { status: "failed", detail: `ffmpeg: ${why.slice(0, 300)}` };
  }
  const check = verifyRemux(before, await probeStreams(temp));
  if (!check.ok) {
    cleanUp();
    return { status: "failed", detail: `not swapped in: ${check.reason}` };
  }
  // The right streams are not the same as a file that plays: read the new
  // file through, and the original too unless the file check has a reading
  // of it as it is now (remuxReadsAsWell has why).
  const afterRead = await readThrough(temp);
  if (!afterRead) {
    cleanUp();
    log(`browser audio: reading ${basename(file)}'s new copy took too long, trying again later`);
    return null;
  }
  const known = fileChecksReady()
    ? db.prepare("SELECT size, mtime_ms, audio_errors, video_errors FROM file_checks WHERE path = ?").get(file)
    : null;
  const current =
    known &&
    known.audio_errors !== null &&
    known.video_errors !== null &&
    !isStale(known, original.size, original.mtimeMs);
  const beforeRead = current
    ? { audioErrors: Number(known.audio_errors), videoErrors: Number(known.video_errors) }
    : await readThrough(file);
  if (!beforeRead) {
    cleanUp();
    log(`browser audio: reading ${basename(file)} took too long, trying again later`);
    return null;
  }
  const reads = remuxReadsAsWell(beforeRead, afterRead);
  if (!reads.ok) {
    cleanUp();
    log(`browser audio: NOT swapping in ${basename(file)}'s new copy: ${reads.reason}`);
    return { status: "failed", detail: `not swapped in: ${reads.reason}` };
  }
  if (await isBeingPlayed(file)) {
    cleanUp();
    log(`browser audio: ${basename(file)} is being watched, trying again later`);
    return null;
  }
  try {
    renameSync(temp, file);
    utimesSync(file, original.atime, original.mtime);
  } catch (error) {
    cleanUp();
    return { status: "failed", detail: `could not put it in place: ${error.message}` };
  }
  noteLibraryChange(file, { reprobe: true });
  return { status: "added", detail: `stereo AAC added (it had ${need.reason})` };
}

async function addBrowserAudioForAWhile() {
  if (!BROWSER_AUDIO || !browserAudioReady()) return null;
  const lines = [];

  // What the curator asked for, first, whatever the day's count.
  for (const { path } of db.prepare("SELECT path FROM browser_audio WHERE status = 'requested' ORDER BY checked_at").all()) {
    if (stopping || (await someoneIsWatching())) break;
    if (!existsSync(path)) {
      db.prepare("DELETE FROM browser_audio WHERE path = ?").run(path);
      continue;
    }
    const outcome = await addBrowserAudio(path);
    if (!outcome) continue;
    recordBrowserAudio(path, outcome.status, outcome.detail);
    lines.push(`${basename(path)}: ${outcome.status === "added" ? "added" : outcome.detail}`);
  }

  const mark = db.prepare("SELECT mtime_ms FROM browser_audio WHERE path = ?").get(AUDIO_WALK_MARK);
  if (!(mark && Date.now() < Number(mark.mtime_ms))) {
    const known = new Map(db.prepare("SELECT path, size, mtime_ms, status FROM browser_audio").all().map((r) => [r.path, r]));
    const present = new Set();
    const todo = [];
    for (const file of walkVideos(LIBRARY)) {
      let stat;
      try {
        stat = statSync(file);
      } catch {
        continue;
      }
      present.add(file);
      if (isStillArriving(stat.mtimeMs, Date.now())) continue;
      const row = known.get(file);
      if (row && row.status !== "requested" && Number(row.size) === stat.size && Number(row.mtime_ms) === Math.round(stat.mtimeMs)) continue;
      todo.push(file);
    }
    for (const path of known.keys()) {
      if (path !== AUDIO_WALK_MARK && !present.has(path)) db.prepare("DELETE FROM browser_audio WHERE path = ?").run(path);
    }

    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    let allowance =
      BROWSER_AUDIO_PER_DAY -
      Number(db.prepare("SELECT COUNT(*) AS n FROM browser_audio WHERE status IN ('added', 'failed') AND checked_at > ?").get(dayAgo)?.n ?? 0);
    let probed = 0;
    let added = 0;
    let waiting = 0;
    for (const file of todo) {
      if (stopping || probed >= BROWSER_AUDIO_PROBES_PER_PASS) break;
      if (await someoneIsWatching()) break;
      probed += 1;
      const before = await probeStreams(file);
      const need = before ? needsBrowserAudio(before.streams, extname(file)) : { needed: false, reason: "the file can't be read" };
      if (!need.needed) {
        recordBrowserAudio(file, before ? "not_needed" : "failed", need.reason);
        continue;
      }
      if (allowance <= 0) {
        waiting += 1; // not recorded: tomorrow's allowance picks it up
        continue;
      }
      allowance -= 1;
      const outcome = await addBrowserAudio(file);
      if (!outcome) continue;
      recordBrowserAudio(file, outcome.status, outcome.detail);
      if (outcome.status === "added") added += 1;
      if (outcome.status !== "not_needed") lines.push(`${basename(file)}: ${outcome.status === "added" ? "added" : outcome.detail}`);
    }
    const left = todo.length - probed + waiting;
    const rest = left <= waiting ? Date.now() + BROWSER_AUDIO_IDLE_MS : 0;
    db.prepare(
      `INSERT INTO browser_audio (path, size, mtime_ms, status, detail, checked_at) VALUES (?, ?, ?, 'not_needed', 'walk marker', ?)
       ON CONFLICT(path) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms, checked_at = excluded.checked_at`,
    ).run(AUDIO_WALK_MARK, left, rest, Date.now());
    if (probed > 0 && added === 0 && lines.length === 0 && probed >= 50) {
      lines.push(`${probed} files looked at, none needed a track`);
    }
    if (waiting > 0) lines.push(`${waiting} waiting for tomorrow's allowance of ${BROWSER_AUDIO_PER_DAY}`);
  }

  if (lines.length === 0) return null;
  await flushLibraryChanges(true);
  const line = lines.slice(0, 6).join("; ") + (lines.length > 6 ? `; and ${lines.length - 6} more` : "");
  log(`browser audio: ${line}`);
  return line;
}

/* ------------------------------------------------------------------ *
 * Sync automatically (scripts/subtitle-autosync.mjs for the rules)
 * ------------------------------------------------------------------ *
 * Subtitle files the curator asked to have lined up with their video, from
 * the sync screen (subtitle_autosync). Only what was asked for, one at a
 * time, and only while nobody is watching: alass reads the film's whole
 * soundtrack (about 20 s of CPU for a 99-minute film on this Mac). The file's first version is kept as
 * "<name>.orig", as a save on the sync screen does.
 */
const ALASS = process.env.ALASS ?? "alass";
const ALASS_TIMEOUT_MS = 30 * 60 * 1000;

function autosyncReady() {
  return Boolean(db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='subtitle_autosync'").get());
}

/** run(), at low priority and with a time limit. */
function runNiceWithTimeout(command, args, timeoutMs) {
  return new Promise((resolveRun) => {
    const child = spawn("nice", ["-n", "15", command, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d) => (stdout = (stdout + d).slice(-20_000)));
    child.stderr.on("data", (d) => (stderr = (stderr + d).slice(-20_000)));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolveRun({ code: -1, stdout, stderr: String(err) });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolveRun({ code: signal === "SIGKILL" ? -2 : code, stdout, stderr });
    });
  });
}

function finishAutosync(path, status, detail) {
  db.prepare("UPDATE subtitle_autosync SET status = ?, detail = ?, finished_at = ? WHERE path = ?").run(status, detail, Date.now(), path);
}

/** Lines one subtitle file up with its video. Returns { status, detail }. */
async function autosyncOne(subtitle, video) {
  if (!existsSync(subtitle)) return { status: "failed", detail: "the subtitle file is gone" };
  if (!existsSync(video)) return { status: "failed", detail: "the video is gone (is the drive connected?)" };
  const temp = join(dirname(subtitle), `.${basename(subtitle, ".srt")}.alass.srt`);
  const cleanUp = () => {
    try {
      if (existsSync(temp)) unlinkSync(temp);
    } catch { /* best effort */ }
  };
  log(`sync automatically: ${basename(subtitle)}`);
  const result = await runNiceWithTimeout(ALASS, alassArgs(video, subtitle, temp), ALASS_TIMEOUT_MS);
  if (result.code !== 0) {
    cleanUp();
    if (result.code === -2) return { status: "failed", detail: "alass took over 30 minutes and was stopped" };
    const why = `${result.stderr}\n${result.stdout}`.trim().split("\n").filter(Boolean).slice(-1)[0] || `alass exited ${result.code}`;
    return { status: "failed", detail: `alass: ${why.slice(0, 300)}` };
  }
  let before;
  let after;
  try {
    before = readFileSync(subtitle, "utf8");
    after = readFileSync(temp, "utf8");
  } catch (error) {
    cleanUp();
    return { status: "failed", detail: `could not read the result: ${error.message}` };
  }
  const judged = judgeResult(before, after);
  if (!judged.ok || !judged.moved) {
    cleanUp();
    return { status: judged.ok ? "done" : "failed", detail: judged.detail };
  }
  try {
    if (!existsSync(`${subtitle}.orig`)) copyFileSync(subtitle, `${subtitle}.orig`);
    writeFileSync(subtitle, after, "utf8");
  } catch (error) {
    cleanUp();
    return { status: "failed", detail: `could not write it: ${error.message}` };
  }
  cleanUp();
  return { status: "done", detail: judged.detail };
}

async function autosyncRequested() {
  if (!autosyncReady()) return null;
  // A run the worker was stopped in the middle of is asked for again.
  db.prepare("UPDATE subtitle_autosync SET status = 'requested', started_at = NULL WHERE status = 'running'").run();
  const lines = [];
  for (const { path, video_path: video } of db
    .prepare("SELECT path, video_path FROM subtitle_autosync WHERE status = 'requested' ORDER BY requested_at")
    .all()) {
    if (stopping || (await someoneIsWatching())) break;
    db.prepare("UPDATE subtitle_autosync SET status = 'running', started_at = ?, detail = NULL WHERE path = ?").run(Date.now(), path);
    const outcome = await autosyncOne(path, video);
    finishAutosync(path, outcome.status, outcome.detail);
    lines.push(`${basename(path)}: ${outcome.detail}`);
  }
  if (!lines.length) return null;
  const line = lines.join("; ");
  log(`sync automatically: ${line}`);
  return line;
}

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
 * download_jobs — Phase 3 offline-download prep. Deliberately a separate,
 * simpler set of statements rather than reusing media_jobs' claim/finish
 * pair: no pause/resume control here (a first download prep is a one-off,
 * not something worth interrupting), and the row never leaves this table
 * to become a media_jobs row or vice versa.
 */
const claimDownload = db.prepare(
  "UPDATE download_jobs SET status = 'running', started_at = ? WHERE id = ? AND status = 'pending'",
);
const setDownloadProgress = db.prepare("UPDATE download_jobs SET progress = ? WHERE id = ?");
const finishDownload = db.prepare(
  `UPDATE download_jobs SET status = ?, output_path = ?, bytes_out = ?, error = ?,
          progress = ?, finished_at = ? WHERE id = ?`,
);
const nextPendingDownload = db.prepare(
  "SELECT * FROM download_jobs WHERE status = 'pending' ORDER BY created_at LIMIT 1",
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
/* ------------------------------------------------------------------ *
 * Virus scan of uploads (upload-scan.mjs)
 * ------------------------------------------------------------------ */

/**
 * Langlois-mode uploads wait in MEDIA_QUARANTINE until scanned clean. ClamAV's
 * clamscan runs here, on demand, never while someone is watching; see
 * upload-scan.mjs for the states and docker-compose.yml for the memory it
 * needs. UPLOAD_SCAN=false turns it off (uploads then wait, as before).
 */
const UPLOAD_SCAN = !/^(0|false|no|off)$/i.test(process.env.UPLOAD_SCAN ?? "true");
const QUARANTINE = abs(process.env.MEDIA_QUARANTINE, "./media-quarantine");
const uploadScanner = clamavScanner({
  dbDir: process.env.CLAMAV_DB ?? "/var/lib/clamav",
  maxMb: Number(process.env.UPLOAD_SCAN_MAX_MB ?? 4000),
  log,
});
const insertUploadEvent = db.prepare(
  `INSERT INTO event_log (id, category, severity, source, message, detail, item_id, username, created_at)
   VALUES (?, 'upload', ?, 'upload_scan', ?, ?, NULL, NULL, ?)`,
);

/** Returns a line for the Health tab, or null when there was nothing to scan. Throws on failure. */
async function scanUploads() {
  if (!UPLOAD_SCAN || stopping) return null;
  const r = await scanWaitingUploads(db, {
    scanner: uploadScanner,
    isBusy: someoneIsWatching,
    heartbeat: (info) => {
      try {
        writeHeartbeat(QUARANTINE, info);
      } catch (err) {
        log("upload scan: heartbeat not written:", err.message);
      }
    },
    logEvent: ({ severity, message, detail }) => {
      try {
        insertUploadEvent.run(randomUUID(), severity, message.slice(0, 2000), JSON.stringify(detail ?? {}).slice(0, 4000), Date.now());
      } catch (err) {
        log("event log write failed:", err.message);
      }
    },
    fileExists: existsSync,
    now: Date.now,
    log,
  });
  if (!r.scanned && !r.recovered) return null;
  const line = `${r.scanned} scanned (${r.clean} clean, ${r.infected} infected, ${r.failed} failed)` + (r.recovered ? `, ${r.recovered} interrupted before` : "");
  log(`upload scan: ${line}`);
  return line;
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
const requeuedDownloads = db
  .prepare("UPDATE download_jobs SET status = 'pending', progress = 0, started_at = NULL WHERE status = 'running'")
  .run();
if (Number(requeuedDownloads.changes) > 0) {
  log(`re-queued ${requeuedDownloads.changes} download job(s) interrupted by a previous shutdown`);
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

/*
 * Files this run has put into the library that Jellyfin has not been told
 * about yet.
 *
 * Every finished job used to ask for a full library scan of its own — two to
 * three minutes of a busy CPU each, so a queue of eight films meant eight
 * scans back to back, the first seven of them for nothing. They are collected
 * here instead and reported once the queue is empty, or after
 * LIBRARY_REFRESH_AFTER_MS when a long queue would otherwise keep a finished
 * film out of sight for hours.
 */
const LIBRARY_REFRESH_AFTER_MS = 10 * 60 * 1000;
const pendingLibraryPaths = new Set();
let pendingLibrarySince = 0;

/*
 * Files rewritten in place, which Jellyfin must read again from scratch.
 *
 * A browser audio track is swapped in with the file's old modified time put
 * back (utimesSync above), and Jellyfin decides whether to re-read a file by
 * that time. The folder refresh alone left it serving the stream list from
 * before: subtitle stream 2 was now the AC3 track, and the player got no
 * subtitles, on all 249 files done this way by 2026-10-29. Each one gets a
 * FullRefresh of its own, which probes the file whatever its date;
 * ReplaceAllMetadata=false keeps its titles, ImageRefreshMode=None its
 * artwork (TMDB stills included).
 */
const pendingReprobePaths = new Set();

function noteLibraryChange(path, { reprobe = false } = {}) {
  if (pendingLibraryPaths.size === 0) pendingLibrarySince = Date.now();
  pendingLibraryPaths.add(path);
  if (reprobe) pendingReprobePaths.add(path);
}

async function flushLibraryChanges(force) {
  if (pendingLibraryPaths.size === 0) return;
  if (!force && Date.now() - pendingLibrarySince < LIBRARY_REFRESH_AFTER_MS) return;
  const paths = [...pendingLibraryPaths];
  pendingLibraryPaths.clear();
  await refreshJellyfin(paths);
  const reprobe = [...pendingReprobePaths];
  pendingReprobePaths.clear();
  if (reprobe.length > 0) await reprobeJellyfin(reprobe);
}

async function reprobeJellyfin(paths) {
  if (!JELLYFIN_API_KEY) return;
  const headers = { Authorization: `MediaBrowser Token="${JELLYFIN_API_KEY}"` };
  try {
    const response = await fetch(`${JELLYFIN_URL}/Items?Recursive=true&IncludeItemTypes=Movie&Fields=Path&Limit=10000`, {
      headers,
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`item list -> ${response.status}`);
    const idByPath = new Map(((await response.json()).Items ?? []).filter((i) => i.Path).map((i) => [i.Path, i.Id]));
    const query = "MetadataRefreshMode=FullRefresh&ImageRefreshMode=None&ReplaceAllMetadata=false&ReplaceAllImages=false";
    let asked = 0;
    for (const path of paths) {
      const id = idByPath.get(path);
      if (!id) continue;
      const refreshed = await fetch(`${JELLYFIN_URL}/Items/${id}/Refresh?${query}`, {
        method: "POST",
        headers,
        signal: AbortSignal.timeout(15_000),
      });
      if (refreshed.ok) asked += 1;
    }
    log(`re-read by Jellyfin -> ${asked} of ${paths.length} rewritten file(s)`);
  } catch (error) {
    log("re-read request failed:", error.message);
  }
}

/**
 * The folders Jellyfin already knows that hold these files, outermost only —
 * or null when any file has none (it sits in the library root), which only a
 * full scan covers. The same rule as src/lib/library-folders.ts, restated
 * because this script runs on its own.
 */
async function jellyfinFoldersFor(paths, headers) {
  const response = await fetch(
    `${JELLYFIN_URL}/Items?Recursive=true&IncludeItemTypes=Folder&Fields=Path&Limit=5000`,
    { headers, signal: AbortSignal.timeout(30_000) },
  );
  if (!response.ok) throw new Error(`folder list -> ${response.status}`);
  // Not the library root: it is a folder to Jellyfin too, and re-reading it
  // is a full scan under another name.
  const folders = ((await response.json()).Items ?? []).filter((f) => f.Path && f.Path !== LIBRARY);
  const within = (path, root) => path === root || path.startsWith(root + "/");

  const chosen = new Map();
  for (const path of paths) {
    let best = null;
    for (const folder of folders) {
      if (within(path, folder.Path) && (!best || folder.Path.length > best.Path.length)) best = folder;
    }
    if (!best) return null;
    chosen.set(best.Path, best);
  }
  const unique = [...chosen.values()];
  return unique.filter((f) => !unique.some((other) => other !== f && within(f.Path, other.Path)));
}

async function refreshJellyfin(paths = []) {
  if (!JELLYFIN_API_KEY) {
    log("JELLYFIN_API_KEY not set — skipping library refresh");
    return;
  }
  const headers = { Authorization: `MediaBrowser Token="${JELLYFIN_API_KEY}"` };
  // Only the folders the files went into, when Jellyfin knows them: seconds,
  // where the full scan below takes minutes.
  try {
    const folders = paths.length > 0 ? await jellyfinFoldersFor(paths, headers) : null;
    if (folders) {
      const query = "Recursive=true&MetadataRefreshMode=Default&ImageRefreshMode=Default&ReplaceAllMetadata=false&ReplaceAllImages=false";
      for (const folder of folders) {
        const response = await fetch(`${JELLYFIN_URL}/Items/${folder.Id}/Refresh?${query}`, {
          method: "POST",
          headers,
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) throw new Error(`refresh of ${folder.Path} -> ${response.status}`);
      }
      log(`library refresh -> ${folders.length} folder(s): ${folders.map((f) => f.Path).join(", ")}`);
      return;
    }
  } catch (error) {
    log("folder refresh failed, scanning the whole library:", error.message);
  }
  try {
    const response = await fetch(`${JELLYFIN_URL}/Library/Refresh`, {
      method: "POST",
      headers,
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
      noteLibraryChange(output);
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
    noteLibraryChange(result.output);
  } catch (error) {
    finishJob.run("failed", null, null, `Publish failed: ${error.message}`, 0, Date.now(), job.id);
    logWorkerFailure(`Publish failed for "${job.title}"`, { title: job.title, sourcePath: job.source_path, error: error.message });
    log(`publish failed for "${job.title}": ${error.message}`);
  }

  return true;
}

/* ------------------------------------------------------------------ *
 * Download prep (Phase 3 offline downloads — download_jobs)
 * ------------------------------------------------------------------ */

/**
 * Simplified sibling of convert() above: same core ffmpeg invocation and
 * progress parsing, but no pause/resume (a download prep is a one-off, not
 * worth interrupting) and writing into DOWNLOADS_CACHE instead of LIBRARY.
 * Kept as its own function rather than generalising convert() itself —
 * convert() is exercised by the watch-folder pipeline running in
 * production every day; a late-night refactor of it to serve a second,
 * newer caller is exactly the kind of change that's safer to keep separate
 * until there's been time to prove this path out.
 */
// Keyed by item id, not title: episode names repeat across shows ("Pilot"),
// and two jobs sharing a path would each serve whichever finished last.
// The title still reaches the user through Content-Disposition.
function downloadCachePath(job) {
  return join(DOWNLOADS_CACHE, `${job.jellyfin_item_id}.mp4`);
}

async function convertForDownload(job, info) {
  const useHw = await detectHardware();
  const output = downloadCachePath(job);
  const temp = join(DOWNLOADS_CACHE, `.${job.jellyfin_item_id}.inprogress.mp4`);

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
    "-f", "mp4",
    "-sn",
    "-progress", "pipe:1", "-nostats",
    temp,
  ];

  log(`preparing download "${job.title}" (${useHw ? "VAAPI" : "software"})`);

  return new Promise((resolveConvert) => {
    const child = spawn(FFMPEG, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let buffer = "";

    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      let micros = null;
      for (const line of lines) {
        const [key, value] = line.split("=");
        if (key === "out_time_us" || key === "out_time_ms") {
          const n = Number(value);
          micros = Number.isFinite(n) ? n : null;
        }
      }
      if (micros !== null && info.duration > 0) {
        const seconds = micros / 1_000_000;
        const percent = Math.max(0, Math.min(99, Math.round((seconds / info.duration) * 100)));
        if (Number.isFinite(percent)) setDownloadProgress.run(percent, job.id);
      }
    });

    child.stderr.on("data", (d) => {
      stderr += d;
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });

    child.on("error", (err) => resolveConvert({ ok: false, error: String(err), temp }));

    child.on("close", (code) => {
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

async function processDownloadJob() {
  const job = nextPendingDownload.get();
  if (!job) return false;

  const claimed = claimDownload.run(Date.now(), job.id);
  if (Number(claimed.changes) !== 1) return false;

  if (!existsSync(job.source_path)) {
    finishDownload.run("failed", null, null, "Source file disappeared", 0, Date.now(), job.id);
    log(`download source missing: ${job.source_path}`);
    return true;
  }

  const info = await probe(job.source_path);
  if (!info) {
    finishDownload.run("failed", null, null, "Not a readable video file", 0, Date.now(), job.id);
    log(`download source unreadable: ${job.source_path}`);
    return true;
  }

  mkdirSync(DOWNLOADS_CACHE, { recursive: true });

  // Already browser/device-friendly: copy straight into the cache rather
  // than re-encoding. copyFileSync, not a stream pipeline — this is a
  // simple whole-file copy with nothing to track progress on, unlike the
  // conversion path below.
  if (alreadyPlayable(job.source_path, info)) {
    const output = downloadCachePath(job);
    try {
      copyFileSync(job.source_path, output);
      const size = statSync(output).size;
      finishDownload.run("done", output, size, null, 100, Date.now(), job.id);
      log(`download ready (no re-encode needed) "${job.title}"`);
    } catch (error) {
      finishDownload.run("failed", null, null, `Copy failed: ${error.message}`, 0, Date.now(), job.id);
      log(`download copy failed for "${job.title}": ${error.message}`);
    }
    return true;
  }

  const result = await convertForDownload(job, info);
  if (!result.ok) {
    try {
      if (existsSync(result.temp)) unlinkSync(result.temp);
    } catch { /* best effort */ }
    finishDownload.run("failed", null, null, result.error, 0, Date.now(), job.id);
    log(`download prep FAILED "${job.title}": ${result.error}`);
    return true;
  }

  try {
    move(result.temp, result.output);
    const size = statSync(result.output).size;
    finishDownload.run("done", result.output, size, null, 100, Date.now(), job.id);
    log(`download ready "${job.title}": ${(size / 1e9).toFixed(2)}GB`);
  } catch (error) {
    finishDownload.run("failed", null, null, `Publish failed: ${error.message}`, 0, Date.now(), job.id);
    log(`download publish failed for "${job.title}": ${error.message}`);
  }

  return true;
}

/* ------------------------------------------------------------------ *
 * The site's scheduled jobs that run here, and the record of each pass
 * (worker-jobs.mjs). The Health tab lists them with everything else.
 * ------------------------------------------------------------------ */

// The backup folder on the drive, Jellyfin's config (read-only) and the
// stack's .env and compose files (read-only), as docker-compose.yml mounts them.
const BACKUP_DIR = abs(process.env.BACKUP_DIR, "/backups");
const BACKUP_JELLYFIN_CONFIG = abs(process.env.BACKUP_JELLYFIN_CONFIG, "/jellyfin-config");
const BACKUP_STACK_DIR = abs(process.env.BACKUP_STACK_DIR, "/stack");

/** What each "worker" job kind means here. Nothing else is ever run for a kind. */
const WORKER_JOBS = {
  backup: ({ forced }) =>
    runBackup({
      root: BACKUP_DIR,
      stamp: backupStamp(Date.now()),
      forced,
      // Beside the database, in the same volume, and removed once compressed.
      snapshot: (destGz) =>
        snapshotDatabase({ db, DatabaseSync, snapshotPath: join(dirname(DB_PATH), ".backup-snapshot.db"), destGz }),
      jellyfinConfig: BACKUP_JELLYFIN_CONFIG,
      stackDir: BACKUP_STACK_DIR,
      log,
    }),
};

async function scheduledJobs() {
  if (stopping) return;
  try {
    await runWorkerJobs(db, WORKER_JOBS, { log });
  } catch (err) {
    log("scheduled jobs failed:", err.message);
  }
}

/** The rows the worker's own passes are recorded under (scheduler.ts BUILTINS). */
const LOOP = {
  conversions: "builtin-loop-conversions",
  uploadScan: "builtin-loop-upload-scan",
  fileCheck: "builtin-loop-file-check",
  browserAudio: "builtin-loop-browser-audio",
  subtitleSync: "builtin-loop-subtitle-sync",
};

function names(rows) {
  const shown = rows.slice(0, 4).map((r) => r.title);
  return shown.join(", ") + (rows.length > 4 ? ` and ${rows.length - 4} more` : "");
}

/** What the conversion and download queues did since `since`, or null for nothing. */
function describeQueueWork(since) {
  const jobs = db.prepare("SELECT status, title FROM media_jobs WHERE finished_at >= ? ORDER BY finished_at").all(since);
  const downloads = db.prepare("SELECT status, title FROM download_jobs WHERE finished_at >= ? ORDER BY finished_at").all(since);
  if (jobs.length === 0 && downloads.length === 0) return null;
  const parts = [];
  const of = (rows, status) => rows.filter((r) => r.status === status);
  if (of(jobs, "done").length) parts.push(`converted ${names(of(jobs, "done"))}`);
  if (of(jobs, "skipped").length) parts.push(`already playable ${names(of(jobs, "skipped"))}`);
  if (of(jobs, "failed").length) parts.push(`FAILED ${names(of(jobs, "failed"))}`);
  if (of(downloads, "done").length) parts.push(`${of(downloads, "done").length} download(s) prepared`);
  if (of(downloads, "failed").length) parts.push(`${of(downloads, "failed").length} download(s) failed`);
  return parts.join("; ") || `${jobs.length + downloads.length} finished`;
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
    await scheduledJobs();
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
    await recordLoopRun(db, LOOP.conversions, async () => {
      const since = Date.now();
      let worked = await processOne();
      while (worked && !stopping) {
        await flushLibraryChanges(false);
        worked = await processOne();
      }
      // One report for the whole batch, now that the queue is empty.
      await flushLibraryChanges(true);
      let workedDownload = await processDownloadJob();
      while (workedDownload && !stopping) {
        workedDownload = await processDownloadJob();
      }
      return describeQueueWork(since);
    }, { log });
    // Uploads waiting for their virus scan, then, last and only with nothing
    // else to do, the library's damage check.
    await recordLoopRun(db, LOOP.uploadScan, scanUploads, { log });
    if (!stopping) await recordLoopRun(db, LOOP.fileCheck, checkFilesForAWhile, { log });
    // Subtitles the curator asked to have synced: before browser audio, since someone is waiting on them.
    if (!stopping && !(await someoneIsWatching())) await recordLoopRun(db, LOOP.subtitleSync, autosyncRequested, { log });
    if (!stopping && !(await someoneIsWatching())) await recordLoopRun(db, LOOP.browserAudio, addBrowserAudioForAWhile, { log });

    if (stopping) break;
    await new Promise((r) => setTimeout(r, POLL_SECONDS * 1000));
  }

  db.close();
  log("stopped");
} else {
  // Queue-only: touch nothing that wasn't explicitly queued (by the gate's
  // Transform button, or a viewer's first download request), then exit. No
  // folder watching, no library-wide auto-discovery — this is what "the
  // worker never runs on its own" means in practice, short of never
  // starting the container at all.
  // The site's scheduled jobs that run here (the backup) first: they come
  // due once a day at most, and a conversion queue can take hours.
  await scheduledJobs();

  let queued = nextPending.get() !== undefined || nextPendingDownload.get() !== undefined;
  if (!queued) {
    log("nothing queued — exiting");
  }

  if (queued) {
    await recordLoopRun(db, LOOP.conversions, async () => {
      const since = Date.now();
      let worked = await processOne();
      while (worked && !stopping) {
        if (await someoneIsWatching()) {
          log("someone is watching — deferring conversions");
          await new Promise((r) => setTimeout(r, POLL_SECONDS * 1000));
          continue;
        }
        await flushLibraryChanges(false);
        worked = await processOne();
      }
      await flushLibraryChanges(true);

      let workedDownload = await processDownloadJob();
      while (workedDownload && !stopping) {
        if (await someoneIsWatching()) {
          log("someone is watching — deferring download prep");
          await new Promise((r) => setTimeout(r, POLL_SECONDS * 1000));
          continue;
        }
        workedDownload = await processDownloadJob();
      }
      return describeQueueWork(since);
    }, { log });
  }

  // Last, and only with nothing else to do: read a few library files through
  // for damage. This process then exits and is started again shortly, so the
  // library is worked through a few minutes at a time.
  // Uploads waiting for their virus scan (it checks for viewers itself).
  await recordLoopRun(db, LOOP.uploadScan, scanUploads, { log });
  // Subtitles the curator asked to have synced: someone is waiting on them, so even with a queue.
  if (!stopping && !(await someoneIsWatching())) await recordLoopRun(db, LOOP.subtitleSync, autosyncRequested, { log });
  if (!stopping && !queued && !(await someoneIsWatching())) await recordLoopRun(db, LOOP.fileCheck, checkFilesForAWhile, { log });
  if (!stopping && !queued && !(await someoneIsWatching())) await recordLoopRun(db, LOOP.browserAudio, addBrowserAudioForAWhile, { log });

  db.close();
  log(stopping ? "stopped" : "queue drained — exiting");
}
