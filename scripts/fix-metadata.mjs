#!/usr/bin/env node
/**
 * Match library items that Jellyfin could not identify on its own.
 *
 *   node scripts/fix-metadata.mjs --url http://127.0.0.1:8096 --key <JELLYFIN_API_KEY>
 *   node scripts/fix-metadata.mjs --dry-run          # show what it would do
 *
 * WHY THIS IS NEEDED
 *
 * Jellyfin names a movie after its folder when that folder holds a single
 * video. A scene-release folder like
 *
 *   Tetris (2023) [2160p] [4K] [WEB] [5.1] [YTS.MX]/
 *
 * becomes the title verbatim, and TMDB has nothing called that, so the match
 * silently fails and you are left with the raw name and no artwork. It is not
 * a network problem and no amount of re-refreshing fixes it: searching TMDB for
 * a clean "Tetris" + 2023 returns the right film immediately.
 *
 * So: strip the release noise, search TMDB, and apply the top result.
 *
 * New files added through the watch folder do not need this — the worker
 * already publishes them as "Title (Year).mp4", which Jellyfin matches first
 * time. This is for a library that predates it.
 */

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const a = process.argv[i];
  if (!a.startsWith("--")) continue;
  const key = a.slice(2);
  const next = process.argv[i + 1];
  if (next && !next.startsWith("--")) {
    args.set(key, next);
    i += 1;
  } else {
    args.set(key, "true");
  }
}

const BASE = (args.get("url") ?? "http://127.0.0.1:8096").replace(/\/+$/, "");
const KEY = args.get("key") ?? process.env.JELLYFIN_API_KEY;
const DRY = args.has("dry-run");

if (!KEY) {
  console.error("Need --key <JELLYFIN_API_KEY> (or set JELLYFIN_API_KEY).");
  process.exit(1);
}

async function api(path, init = {}) {
  const url = `${BASE}${path}${path.includes("?") ? "&" : "?"}api_key=${KEY}`;
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${res.status}`);
  const text = await res.text();
  return text.trim() === "" ? null : JSON.parse(text);
}

/** Same truncate-at-first-release-marker approach the ingest worker uses. */
const RELEASE_MARKER =
  /\b(1080p|2160p|1440p|720p|480p|4k|uhd|web[- ]?dl|webrip|web|bluray|blu[- ]?ray|brrip|bdrip|dvdrip|hdrip|hdtv|x264|x265|h ?264|h ?265|hevc|avc|aac\d*|ac3|eac3|dts(?:[- ]?hd)?|truehd|ddp?\d*|10bit|8bit|hdr\d*|remux|proper|repack|japanese|english|dual|multi)\b/i;

function cleanName(raw) {
  let s = raw.replace(/[._]/g, " ");
  const cut = s.search(RELEASE_MARKER);
  if (cut > 0) s = s.slice(0, cut);

  let year = null;
  const m = s.match(/\b((?:19|20)\d{2})\b/);
  if (m) {
    year = Number(m[1]);
    s = s.slice(0, m.index);
  }
  s = s
    .replace(/\[[^\]]*\]|\([^)]*\)/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/[-–([{\s]+$/, "")
    .trim();
  return { name: s, year };
}

const items = (
  await api("/Items?Recursive=true&IncludeItemTypes=Movie&Limit=500&Fields=ProviderIds,Path")
).Items;

console.log(`${items.length} movies in the library\n`);

let fixed = 0;
let skipped = 0;
let failed = 0;

for (const item of items) {
  const alreadyMatched = Object.keys(item.ProviderIds ?? {}).length > 0;
  if (alreadyMatched) {
    console.log(`  ok      ${item.Name}`);
    skipped += 1;
    continue;
  }

  const { name, year } = cleanName(item.Name);
  if (!name) {
    console.log(`  skip    ${item.Name} (nothing usable left after cleaning)`);
    skipped += 1;
    continue;
  }

  let results;
  try {
    results = await api(`/Items/RemoteSearch/Movie`, {
      method: "POST",
      body: JSON.stringify({
        ItemId: item.Id,
        SearchInfo: { Name: name, Year: year ?? undefined },
        IncludeDisabledProviders: true,
      }),
    });
  } catch (error) {
    console.log(`  ERROR   ${item.Name} -> search failed: ${error.message}`);
    failed += 1;
    continue;
  }

  // Prefer a result whose year matches; TMDB often returns remakes first.
  const best =
    (results ?? []).find((r) => year && r.ProductionYear === year) ?? (results ?? [])[0];

  if (!best) {
    console.log(`  NOMATCH ${item.Name}  (searched "${name}"${year ? ` ${year}` : ""})`);
    failed += 1;
    continue;
  }

  console.log(
    `  ${DRY ? "would  " : "match  "} ${item.Name}\n` +
      `            -> ${best.Name} (${best.ProductionYear})  tmdb=${best.ProviderIds?.Tmdb ?? "?"}`,
  );

  if (DRY) continue;

  try {
    await api(`/Items/RemoteSearch/Apply/${item.Id}?replaceAllImages=true`, {
      method: "POST",
      body: JSON.stringify(best),
    });
    fixed += 1;
  } catch (error) {
    console.log(`            apply failed: ${error.message}`);
    failed += 1;
  }
}

console.log(
  `\n${DRY ? "(dry run) " : ""}matched ${fixed}, already fine ${skipped}, failed ${failed}`,
);
if (!DRY && fixed > 0) {
  console.log("Artwork downloads continue in the background for a minute or two.");
}
