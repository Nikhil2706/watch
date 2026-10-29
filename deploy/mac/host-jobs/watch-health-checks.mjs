// The library half of the nightly health check (watch-health.sh), run inside
// the worker container, which has the database, Jellyfin and /media:
//
//   docker exec -i jellyfin-gate-worker node --input-type=module - < watch-health-checks.mjs
//
// Read-only: it never writes to the database, Jellyfin or the drive. It prints
// the report's library sections, then one last line, `PROBLEMS <n>`, the
// count of things that want someone's attention, which watch-health.sh reads.
//
// Each check is one that was done by hand at least once (2026-10-27..29):
// damaged files, files Jellyfin knows only as they were before the worker
// rewrote them, browser audio that failed, TV episodes missing against TMDB.

import { DatabaseSync } from "node:sqlite";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const db = new DatabaseSync(process.env.DATABASE_PATH ?? "/app/data/jellyfin-gate.db", { readOnly: true });
const JF = (process.env.JELLYFIN_URL ?? "http://jellyfin:8096").replace(/\/+$/, "");
const H = { Authorization: `MediaBrowser Token="${process.env.JELLYFIN_API_KEY ?? ""}"` };
const LIBRARY = process.env.MEDIA_LIBRARY ?? "/media";
const DAY = 86_400_000;
const since = Date.now() - DAY;
const VIDEO = /\.(mp4|mkv|avi|m4v|mov|wmv|mpg|mpeg|ts|webm|flv|m2ts|vob|divx|ogm)$/i;

let problems = 0;
const out = [];
const say = (line = "") => out.push(line);
const short = (p) => p.replace(`${LIBRARY}/`, "");
const list = (items, max = 12) => {
  for (const item of items.slice(0, max)) say(`    ${item}`);
  if (items.length > max) say(`    … and ${items.length - max} more`);
};
const tableExists = (name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));

// ---- Jellyfin's view of each file against the file itself ------------------
// A file rewritten in place (browser audio) whose old date was put back kept
// its old stream list in Jellyfin: subtitles asked for by index came back
// empty. Read item by item: the big library listing was seen serving the old
// sizes even after the items themselves had been re-read.
async function jellyfinItems() {
  const r = await fetch(`${JF}/Items?Recursive=true&IncludeItemTypes=Movie&Fields=Path&Limit=10000`, { headers: H });
  if (!r.ok) throw new Error(`Jellyfin item list -> ${r.status}`);
  const ids = ((await r.json()).Items ?? []).filter((i) => i.Path).map((i) => i.Id);
  const items = [];
  for (let k = 0; k < ids.length; k += 40) {
    const batch = await fetch(`${JF}/Items?Ids=${ids.slice(k, k + 40).join(",")}&Fields=Path,MediaSources`, { headers: H });
    if (!batch.ok) throw new Error(`Jellyfin items -> ${batch.status}`);
    items.push(...((await batch.json()).Items ?? []));
  }
  return items;
}

say("JELLYFIN");
try {
  const items = await jellyfinItems();
  const stale = [];
  const gone = [];
  for (const item of items) {
    let size;
    try {
      size = statSync(item.Path).size;
    } catch {
      gone.push(short(item.Path));
      continue;
    }
    const known = item.MediaSources?.[0]?.Size;
    if (known && known !== size) stale.push(short(item.Path));
  }
  say(`  ${items.length} items`);
  if (stale.length) {
    problems += 1;
    say(`  ! ${stale.length} with an out-of-date stream list (subtitles/audio may not load). Fix: re-read them in Jellyfin (Refresh, "Scan for new and updated files" is not enough; use FullRefresh with images off):`);
    list(stale);
  } else say("  ok: every file matches what Jellyfin has for it");
  if (gone.length) {
    problems += 1;
    say(`  ! ${gone.length} in Jellyfin whose file is not on the drive:`);
    list(gone);
  }
} catch (error) {
  problems += 1;
  say(`  ! could not ask Jellyfin: ${error.message}`);
}

// ---- The worker's file check --------------------------------------------------
say();
say("FILE CHECK (damaged files are kept off the site)");
if (tableExists("file_checks")) {
  const rows = db.prepare("SELECT path, verdict, detail, allowed, checked_at FROM file_checks WHERE path LIKE '/%'").all();
  const damaged = rows.filter((r) => r.verdict === "damaged" && !r.allowed);
  const fresh = damaged.filter((r) => r.checked_at > since);
  say(`  ${rows.length} checked: ${rows.filter((r) => r.verdict === "ok").length} ok, ${rows.filter((r) => r.verdict === "minor").length} minor, ${damaged.length} damaged and hidden`);
  if (fresh.length) {
    problems += 1;
    say(`  ! ${fresh.length} newly found damaged in the last day:`);
    list(fresh.map((r) => `${short(r.path)}  (${r.detail})`));
  }
  // A whole run of "cannot be opened" at once is the drive dropping out, not
  // damage (2026-10-27): say so rather than send someone off to redownload.
  const unopenable = fresh.filter((r) => /cannot be opened/.test(r.detail ?? ""));
  if (unopenable.length >= 5) say(`  ? ${unopenable.length} of those "cannot be opened" at once: check the drive did not drop out before redownloading anything`);
  const checked = new Set(rows.map((r) => r.path));
  let unchecked = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (VIDEO.test(entry.name) && !entry.name.startsWith(".") && !checked.has(full)) unchecked += 1;
    }
  };
  try {
    walk(LIBRARY);
    say(`  ${unchecked} video file(s) not checked yet (the worker reads about 100 a day)`);
  } catch (error) {
    problems += 1;
    say(`  ! could not read ${LIBRARY}: ${error.message}`);
  }
} else say("  (no file_checks table)");

// ---- Browser audio ------------------------------------------------------------
say();
say("BROWSER AUDIO (a stereo AAC track so the browser plays the file itself)");
if (tableExists("browser_audio")) {
  // A file the file check already calls damaged can't be read here either;
  // it is on the redownload list, not a fresh failure.
  const failed = db
    .prepare(
      `SELECT b.path, b.detail FROM browser_audio b
       WHERE b.status = 'failed' AND b.checked_at > ?
         AND NOT EXISTS (SELECT 1 FROM file_checks f WHERE f.path = b.path AND f.verdict = 'damaged')`,
    )
    .all(since);
  const waiting = db.prepare("SELECT COUNT(*) AS n FROM browser_audio WHERE status = 'requested'").get().n;
  const added = db.prepare("SELECT COUNT(*) AS n FROM browser_audio WHERE status = 'added' AND checked_at > ?").get(since).n;
  say(`  last day: ${added} added, ${failed.length} failed; ${waiting} queued`);
  if (failed.length) {
    problems += 1;
    say("  ! failed (\"can't be read\" in a batch usually means the drive dropped out; re-queue with \"Add browser audio now\"):");
    list(failed.map((r) => `${short(r.path)}  (${r.detail})`));
  }
}

// ---- TV shows against TMDB ------------------------------------------------------
// Per show: which TMDB episodes no file is for, and shows with no TMDB link at
// all. A file counts when its name says which episode it is, or when the
// episode-stills job has mapped it (its "still" link, which also carries
// by-hand corrections such as E.R. season 1). Read from the TMDB store already
// on disk; nothing is fetched.
//
// The names are read as src/lib/episode-markers.ts reads them. That module is
// TypeScript in the site's build, which this container does not carry, so
// the same patterns are restated here; a name only that module understands
// shows up below as a missing episode, never as a wrong one.
function episodeOf(path, singleSeason) {
  const name = path.split("/").pop().replace(/\.[^.]+$/, "");
  const folder = path.split("/").slice(-2, -1)[0] ?? "";
  const pair = (m) => (m ? { season: Number(m[1]), episode: Number(m[2]) } : null);
  const found =
    pair(/\bS(\d{1,2})E(\d{1,3})(?:E\d{1,3})?\b/i.exec(name)) ??
    pair(/\b(\d{1,2})x(\d{1,3})\b/i.exec(name)) ??
    pair(/\bSeason[\s._-]*(\d{1,2})[\s._-]*Episode[\s._-]*(\d{1,3})\b/i.exec(name));
  if (found) return found;
  const bare = /\bE(?:p(?:isode)?)?\.?\s*(\d{1,3})\b/i.exec(name);
  if (bare) {
    const season = /season[\s._-]*(\d+)/i.exec(folder);
    return season ? { season: Number(season[1]), episode: Number(bare[1]) } : singleSeason ? { season: 1, episode: Number(bare[1]) } : null;
  }
  const dashed = /\s-\s([1-9])(\d{2})\s-\s/.exec(name);
  if (dashed && dashed[2] !== "00") return { season: Number(dashed[1]), episode: Number(dashed[2]) };
  const part = /(?:^|[^\d])(\d{1,2})\s?[⁄∕]\s?(\d{1,2})(?!\d)/.exec(name) ?? /(?:^|\s)(\d{1,2})-(\d{1,2})(?=\s|$)/.exec(name);
  if (part && Number(part[1]) >= 1 && Number(part[1]) <= Number(part[2])) return { season: 1, episode: Number(part[1]) };
  return null;
}
say();
say("TV SHOWS (against TMDB)");
const groups = db
  .prepare(
    `SELECT g.group_id, MIN(g.group_name) AS name, COUNT(*) AS files, l.tmdb_kind, l.tmdb_id, s.kind
     FROM library_groups g
     LEFT JOIN tmdb_links l ON l.subject_type = 'group' AND l.subject_id = g.group_id
     LEFT JOIN library_group_series s ON s.group_id = g.group_id
     GROUP BY g.group_id ORDER BY name`,
  )
  .all();
const unlinked = [];
for (const g of groups) {
  if (g.kind === "movie" || g.tmdb_kind === "movie") continue;
  if (g.tmdb_kind !== "tv") {
    unlinked.push(`${g.name} (${g.files} files)`);
    continue;
  }
  const show = db.prepare("SELECT payload FROM tmdb_cache WHERE kind = 'tv' AND tmdb_id = ? AND season = -1").get(g.tmdb_id);
  if (!show) continue;
  const seasons = (JSON.parse(show.payload).seasons ?? []).filter((s) => s.season_number > 0);
  const have = new Set();
  const stills = new Map(
    db
      .prepare("SELECT subject_id, season, episode FROM tmdb_links WHERE subject_type = 'still' AND season IS NOT NULL")
      .all()
      .map((r) => [r.subject_id, `${r.season}x${r.episode}`]),
  );
  for (const { path } of db.prepare("SELECT path FROM library_groups WHERE group_id = ?").all(g.group_id)) {
    const still = stills.get(path);
    if (still) have.add(still);
    const parsed = episodeOf(path, seasons.length === 1);
    // A still link wins for its file: it is where by-hand corrections live.
    if (parsed && !still) have.add(`${parsed.season}x${parsed.episode}`);
  }
  const missing = [];
  for (const s of seasons) {
    const absent = [];
    for (let e = 1; e <= s.episode_count; e++) if (!have.has(`${s.season_number}x${e}`)) absent.push(e);
    if (absent.length === s.episode_count) missing.push(`S${s.season_number}: all ${s.episode_count}`);
    else if (absent.length) missing.push(`S${s.season_number}: E${absent.join(", E")}`);
  }
  if (missing.length) say(`  ${g.name}: no file for ${missing.join("; ")}`);
}
if (unlinked.length) say(`  not linked to TMDB: ${unlinked.join(", ")}`);
say("  (a missing episode can also be one whose file TMDB has no still for: check before downloading)");

say();
say(`PROBLEMS ${problems}`);
console.log(out.join("\n"));
