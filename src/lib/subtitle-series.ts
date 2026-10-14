import "server-only";

import { execFile } from "node:child_process";
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";

import { getAdminMovies } from "./admin-library-cache";
import { asRow, asRows, getDb } from "./db";
import { parseEpisodeInfo } from "./episode-naming";
import { getSubtitleTrackText, refreshItem, type AdminMovieListItem } from "./jellyfin";
import { downloadSubtitle, isOpenSubtitlesConfigured, searchEpisodeSubtitles } from "./opensubtitles";
import { buildSeriesPlan, type BuiltPlan, type SeriesEpisode } from "./subtitle-series-plan";
import { getCached, getLink } from "./tmdb-store";

/**
 * Subtitles for every episode of a show that has none — wiring only; the
 * judgement is in subtitle-series-plan.ts.
 *
 * Plan, then apply. Planning reads the show's episodes from Jellyfin (which
 * knows each file's built-in tracks) and the disk (which knows the sidecar
 * files), learns which OpenSubtitles upload a reference episode's subtitle is
 * when there is one, and picks a file for each episode with no subtitle at
 * all. Applying downloads only what the person accepted and writes it next to
 * the video as "<video>.eng.srt", which Jellyfin reads.
 *
 * Quota: search is free; each download is one of the day's allowance. A plan
 * spends at most IDENTIFY_LIMIT (5), only when there is a reference to
 * identify; applying spends one per ticked episode.
 */

const LANG = "en";
const SUB_EXTENSIONS = new Set([".srt", ".ass", ".ssa", ".vtt", ".sub"]);

/** OpenSubtitles' moviehash: file size plus the 64-bit sums of the first and last 64 KB. */
export function moviehash(path: string): string {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const chunk = 65536;
    let hash = BigInt(size);
    const buf = Buffer.alloc(chunk);
    for (const offset of [0, Math.max(0, size - chunk)]) {
      const read = readSync(fd, buf, 0, chunk, offset);
      for (let i = 0; i + 8 <= read; i += 8) hash = (hash + buf.readBigUInt64LE(i)) & 0xffffffffffffffffn;
    }
    return hash.toString(16).padStart(16, "0");
  } finally {
    closeSync(fd);
  }
}

function safeMoviehash(path: string): string | null {
  try {
    return existsSync(path) ? moviehash(path) : null;
  } catch {
    return null;
  }
}

/** A subtitle file sitting next to the video, if there is one ("x.srt", "x.eng.srt"...). */
function externalSubtitle(videoPath: string): string | null {
  const dir = dirname(videoPath);
  const stem = basename(videoPath, extname(videoPath));
  try {
    const hit = readdirSync(dir).find(
      (f) => SUB_EXTENSIONS.has(extname(f).toLowerCase()) && (f.startsWith(stem + ".") || f === stem + extname(f)),
    );
    return hit ? join(dir, hit) : null;
  } catch {
    return null;
  }
}

function showIds(groupId: string): { imdbId: string | null; tmdbId: number | null } {
  const link = getLink("group", groupId);
  if (!link || link.tmdbKind !== "tv" || link.tmdbId <= 0) return { imdbId: null, tmdbId: null };
  const show = getCached<{ external_ids?: { imdb_id?: string } }>("tv", link.tmdbId);
  return { imdbId: show?.imdbId ?? show?.payload.external_ids?.imdb_id ?? null, tmdbId: link.tmdbId };
}

/**
 * The episode's own IMDb id, only when OMDb says it is an episode of THIS show
 * with these numbers — Jellyfin matches episode files as films, often wrongly.
 * The TMDB episode id comes from the season already cached (no call).
 */
function episodeIds(
  item: AdminMovieListItem | undefined,
  show: { imdbId: string | null; tmdbId: number | null },
  season: number,
  episode: number,
): { episodeImdbId: string | null; episodeTmdbId: number | null } {
  let episodeImdbId: string | null = null;
  const own = item?.ProviderIds?.Imdb;
  if (own && show.imdbId) {
    const kind = asRow<{ series_imdb_id: string | null; season: number | null; episode: number | null }>(
      getDb()
        .prepare("SELECT series_imdb_id, season, episode FROM omdb_title_kind WHERE imdb_id = ? AND type = 'episode'")
        .get(own),
    );
    if (kind && kind.series_imdb_id === show.imdbId && kind.season === season && kind.episode === episode) {
      episodeImdbId = own;
    }
  }
  let episodeTmdbId: number | null = null;
  if (show.tmdbId) {
    const cached = getCached<{ episodes?: Array<{ id?: number; episode_number: number }> }>("season", show.tmdbId, season);
    episodeTmdbId = cached?.payload.episodes?.find((x) => x.episode_number === episode)?.id ?? null;
  }
  return { episodeImdbId, episodeTmdbId };
}

/**
 * A built-in track's text. Through Jellyfin, which extracts it with its own
 * ffmpeg; the gate image carries no ffmpeg. Where ffmpeg is on the PATH (a dev
 * machine, the worker image) and Jellyfin can't be asked, it is read directly.
 */
async function readEmbeddedText(item: AdminMovieListItem | undefined, path: string, index: number): Promise<string> {
  const sourceId = item?.MediaSources?.[0]?.Id;
  let jellyfinError: unknown = null;
  if (item && sourceId) {
    try {
      return await getSubtitleTrackText(item.Id, sourceId, index);
    } catch (error) {
      jellyfinError = error;
    }
  }
  try {
    return await ffmpegExtract(path, index);
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT" && jellyfinError) throw jellyfinError;
    throw error;
  }
}

function ffmpegExtract(path: string, index: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "ffmpeg",
      ["-v", "error", "-nostdin", "-i", path, "-map", `0:${index}`, "-f", "srt", "-"],
      { maxBuffer: 16 * 1024 * 1024, timeout: 120_000 },
      (error, stdout, stderr) => {
        if (error) {
          if ((error as { code?: unknown }).code === "ENOENT") reject(error);
          else reject(new Error(`ffmpeg could not read track ${index}: ${String(stderr).trim().slice(0, 200) || error.message}`));
        } else resolve(stdout);
      },
    );
  });
}

export interface SeriesSubtitlePlan extends BuiltPlan {
  groupId: string;
  groupName: string;
  showImdbId: string | null;
}

/**
 * The plan for one show: which reference it learned from (an .srt, a built-in
 * track, or none), and for every episode with no subtitle at all, what would
 * be downloaded and which method chose it.
 */
export async function planSeriesSubtitles(groupId: string): Promise<SeriesSubtitlePlan> {
  if (!isOpenSubtitlesConfigured()) {
    throw new Error("OpenSubtitles isn't set up: put OPENSUBTITLES_API_KEY in .env and restart the gate.");
  }

  const rows = asRows<{ path: string; group_name: string }>(
    getDb().prepare("SELECT path, group_name FROM library_groups WHERE group_id = ?").all(groupId),
  );
  if (rows.length === 0) throw new Error("This show no longer exists; reload the Library tab.");
  const hidden = new Set(
    asRows<{ path: string }>(getDb().prepare("SELECT path FROM library_excluded").all()).map((r) => r.path),
  );
  const show = showIds(groupId);

  const items = new Map<string, AdminMovieListItem>();
  for (const m of await getAdminMovies()) if (m.Path) items.set(m.Path, m);

  const visible = rows.filter((r) => !hidden.has(r.path));
  const parsed = visible.map((r) => ({ path: r.path, ...parseEpisodeInfo(r.path) }));
  const unparsed = parsed.filter((e) => e.episode === null).length;
  const episodes: SeriesEpisode[] = parsed
    .filter((e): e is typeof e & { episode: number } => e.episode !== null)
    .map((e) => {
      const season = e.season ?? 1;
      const item = items.get(e.path);
      const streams = (item?.MediaSources?.[0]?.MediaStreams ?? []).filter((s) => s.Type === "Subtitle");
      return {
        path: e.path,
        season,
        episode: e.episode,
        externalFile: externalSubtitle(e.path),
        embedded: streams
          .filter((s) => !s.IsExternal && typeof s.Index === "number")
          .map((s) => ({ index: s.Index!, codec: s.Codec ?? null, language: s.Language ?? null })),
        jellyfinHasSubtitle: streams.length > 0,
        ...episodeIds(item, show, season, e.episode),
      };
    })
    .sort((a, b) => a.season - b.season || a.episode - b.episode);

  if (episodes.length === 0) {
    throw new Error(
      "None of this show's files has a season/episode number in its name (like S01E07), so there is nothing to search by. Rename the files, then try again.",
    );
  }
  if (!show.imdbId && !show.tmdbId && !episodes.some((e) => e.episodeImdbId || e.episodeTmdbId)) {
    throw new Error(
      "This show isn't linked to TMDB, so OpenSubtitles can't be searched for it. Link it under Show settings → TMDB, then try again.",
    );
  }

  const byPath = (p: string) => items.get(p);
  const plan = await buildSeriesPlan(
    { episodes, unparsed, show },
    {
      search: (input) => searchEpisodeSubtitles({ ...input, languages: LANG }),
      download: (fileId) => downloadSubtitle(fileId),
      readExternal: async (file) => readFileSync(file, "utf8"),
      readEmbedded: (e, track) => readEmbeddedText(byPath(e.path), e.path, track.index),
      moviehash: safeMoviehash,
      basename: (p) => basename(p),
    },
  );
  return { groupId, groupName: rows[0]!.group_name, showImdbId: show.imdbId, ...plan };
}

export interface ApplyResult {
  path: string;
  ok: boolean;
  message: string;
}

/**
 * Downloads the accepted picks and writes each next to its video. Only paths
 * in this show, still without a subtitle of any kind, are touched — the plan came back
 * from the browser, so it is re-checked rather than trusted.
 */
export async function applySeriesSubtitles(
  groupId: string,
  picks: ReadonlyArray<{ path: string; fileId: number }>,
): Promise<{ results: ApplyResult[]; downloadsLeft: number | null }> {
  const inShow = new Set(
    asRows<{ path: string }>(getDb().prepare("SELECT path FROM library_groups WHERE group_id = ?").all(groupId)).map(
      (r) => r.path,
    ),
  );
  const byPath = new Map((await getAdminMovies()).map((m) => [m.Path, m]));
  const results: ApplyResult[] = [];
  let left: number | null = null;

  for (const { path, fileId } of picks) {
    if (!inShow.has(path)) {
      results.push({ path, ok: false, message: "Not an episode of this show." });
      continue;
    }
    if (externalSubtitle(path)) {
      results.push({ path, ok: false, message: "Already has a subtitle; left alone." });
      continue;
    }
    if (byPath.get(path)?.MediaSources?.[0]?.MediaStreams?.some((s) => s.Type === "Subtitle")) {
      results.push({ path, ok: false, message: "Already has a built-in subtitle; left alone." });
      continue;
    }
    if (left !== null && left <= 0) {
      results.push({ path, ok: false, message: "Out of downloads for today." });
      continue;
    }
    try {
      const d = await downloadSubtitle(fileId);
      left = d.remaining;
      const target = `${path.slice(0, path.length - extname(path).length)}.eng.srt`;
      writeFileSync(target, d.content, "utf8");
      const itemId = byPath.get(path)?.Id;
      if (itemId) await refreshItem(itemId).catch(() => undefined);
      results.push({ path, ok: true, message: basename(target) });
    } catch (error) {
      results.push({ path, ok: false, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { results, downloadsLeft: left };
}
