import "server-only";

import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";

import { getAdminMovies } from "./admin-library-cache";
import { asRows, getDb } from "./db";
import { parseEpisodeInfo } from "./episode-naming";
import { refreshItem } from "./jellyfin";
import { downloadSubtitle, isOpenSubtitlesConfigured, searchEpisodeSubtitles } from "./opensubtitles";
import {
  pickFromFamily,
  subtitleTextSimilarity,
  type SubtitleCandidate,
  type SubtitleFamily,
} from "./subtitle-match";
import { getCached, getLink } from "./tmdb-store";

/**
 * Subtitles for a whole show from the one episode a person got right.
 *
 * Plan, then apply. Planning finds which OpenSubtitles upload the approved
 * file is (by downloading that episode's top few candidates and comparing the
 * words — the only way to know, since the approved file was renamed to match
 * its video), then picks each other episode's subtitle from the same family
 * (subtitle-match.ts). Applying downloads only what the person accepted and
 * writes it next to the video as "<video>.eng.srt", which Jellyfin reads.
 *
 * Quota: search is free; each download is one of the day's allowance. A plan
 * spends at most IDENTIFY_LIMIT, and only when the family isn't obvious.
 */

const LANG = "en";
const SUB_EXTENSIONS = new Set([".srt", ".ass", ".ssa", ".vtt", ".sub"]);
const IDENTIFY_LIMIT = 5;

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

function showImdbId(groupId: string): string | null {
  const link = getLink("group", groupId);
  if (!link || link.tmdbKind !== "tv" || link.tmdbId <= 0) return null;
  const show = getCached<{ external_ids?: { imdb_id?: string } }>("tv", link.tmdbId);
  return show?.imdbId ?? show?.payload.external_ids?.imdb_id ?? null;
}

export interface EpisodePlan {
  path: string;
  season: number;
  episode: number;
  status: "approved" | "has-subtitle" | "planned" | "no-match" | "error";
  pick?: { fileId: number; release: string | null; fileName: string | null; uploader: string | null; why: string[] };
  note?: string;
}

export interface SeriesSubtitlePlan {
  groupId: string;
  groupName: string;
  showImdbId: string | null;
  reference: {
    path: string;
    season: number;
    episode: number;
    family: SubtitleFamily | null;
    similarity: number | null;
    note: string;
  } | null;
  episodes: EpisodePlan[];
  downloadsUsed: number;
  downloadsLeft: number | null;
}

function candidateFamily(c: SubtitleCandidate): SubtitleFamily {
  return { uploader: c.uploader, release: c.release, fileName: c.fileName, hearingImpaired: c.hearingImpaired, fps: c.fps };
}

/**
 * Which search result the approved file is. Free when OpenSubtitles says only
 * one candidate was synced to the approved episode's video — that is almost
 * certainly where it came from. Otherwise downloads up to IDENTIFY_LIMIT
 * candidates and compares the words.
 */
async function identifyFamily(
  approvedText: string,
  candidates: SubtitleCandidate[],
  budget: { used: number; left: number | null },
): Promise<{ family: SubtitleFamily; similarity: number | null; note: string } | null> {
  const ordered = [...candidates].sort(
    (a, b) => Number(b.hashMatch) - Number(a.hashMatch) || b.downloadCount - a.downloadCount,
  );
  let best: { c: SubtitleCandidate; sim: number } | null = null;
  for (const c of ordered.slice(0, IDENTIFY_LIMIT)) {
    if (budget.left !== null && budget.left <= 0) break;
    try {
      const d = await downloadSubtitle(c.fileId);
      budget.used += 1;
      budget.left = d.remaining;
      const sim = subtitleTextSimilarity(approvedText, d.content);
      if (!best || sim > best.sim) best = { c, sim };
      if (sim >= 0.9) break; // unmistakable; stop spending
    } catch {
      /* one failed download is not a reason to give up on the rest */
    }
  }
  if (best && best.sim >= 0.5) {
    return {
      family: candidateFamily(best.c),
      similarity: best.sim,
      note: `Your file matches ${best.c.uploader ?? "an upload"}'s "${best.c.release ?? best.c.fileName}" (${Math.round(best.sim * 100)}% of lines).`,
    };
  }
  const synced = ordered.filter((c) => c.hashMatch);
  if (synced.length > 0) {
    return {
      family: candidateFamily(synced[0]!),
      similarity: best?.sim ?? null,
      note: "Couldn't confirm which upload your file is; following the one synced to that episode's video.",
    };
  }
  return null;
}

/**
 * The plan for one show: the approved episode, the family it came from, and
 * for every other episode missing subtitles, what would be downloaded and
 * why. `seasons` narrows it ("reference" = the approved episode's season).
 */
export async function planSeriesSubtitles(
  groupId: string,
  options: { allSeasons?: boolean } = {},
): Promise<SeriesSubtitlePlan> {
  if (!isOpenSubtitlesConfigured()) throw new Error("OpenSubtitles is not configured.");

  const rows = asRows<{ path: string; group_name: string }>(
    getDb().prepare("SELECT path, group_name FROM library_groups WHERE group_id = ?").all(groupId),
  );
  if (rows.length === 0) throw new Error("No such show.");
  const hidden = new Set(
    asRows<{ path: string }>(getDb().prepare("SELECT path FROM library_excluded").all()).map((r) => r.path),
  );
  const imdb = showImdbId(groupId);

  const eps = rows
    .filter((r) => !hidden.has(r.path))
    .map((r) => ({ path: r.path, ...parseEpisodeInfo(r.path) }))
    .filter((e): e is typeof e & { season: number; episode: number } => e.episode !== null)
    .map((e) => ({ ...e, season: e.season ?? 1 }))
    .sort((a, b) => a.season - b.season || a.episode - b.episode);

  const plan: SeriesSubtitlePlan = {
    groupId,
    groupName: rows[0]!.group_name,
    showImdbId: imdb,
    reference: null,
    episodes: [],
    downloadsUsed: 0,
    downloadsLeft: null,
  };

  const approved = eps.find((e) => externalSubtitle(e.path));
  if (!approved) throw new Error("No episode of this show has a subtitle file yet. Add the right one to one episode first.");
  if (!imdb) throw new Error("This show isn't linked to TMDB yet, so its IMDb id is unknown.");

  const budget = { used: 0, left: null as number | null };
  const approvedFile = externalSubtitle(approved.path)!;
  const refCandidates = await searchEpisodeSubtitles({
    parentImdbId: imdb,
    season: approved.season,
    episode: approved.episode,
    languages: LANG,
    moviehash: existsSync(approved.path) ? moviehash(approved.path) : null,
  });
  const identified = await identifyFamily(readFileSync(approvedFile, "utf8"), refCandidates, budget);
  plan.reference = {
    path: approved.path,
    season: approved.season,
    episode: approved.episode,
    family: identified?.family ?? null,
    similarity: identified?.similarity ?? null,
    note: identified?.note ?? "Couldn't tell which upload your file is, so nothing can be matched to it.",
  };

  for (const e of eps) {
    if (!options.allSeasons && e.season !== approved.season) continue;
    const base = { path: e.path, season: e.season, episode: e.episode };
    if (e.path === approved.path) {
      plan.episodes.push({ ...base, status: "approved" });
      continue;
    }
    if (externalSubtitle(e.path)) {
      plan.episodes.push({ ...base, status: "has-subtitle" });
      continue;
    }
    if (!identified) {
      plan.episodes.push({ ...base, status: "no-match", note: "No family to match against." });
      continue;
    }
    try {
      const candidates = await searchEpisodeSubtitles({
        parentImdbId: imdb,
        season: e.season,
        episode: e.episode,
        languages: LANG,
        moviehash: existsSync(e.path) ? moviehash(e.path) : null,
      });
      const best = pickFromFamily(candidates, identified.family);
      plan.episodes.push(
        best
          ? {
              ...base,
              status: "planned",
              pick: {
                fileId: best.candidate.fileId,
                release: best.candidate.release,
                fileName: best.candidate.fileName,
                uploader: best.candidate.uploader,
                why: best.why,
              },
            }
          : { ...base, status: "no-match", note: `${candidates.length} results, none from the same family.` },
      );
    } catch (error) {
      plan.episodes.push({ ...base, status: "error", note: error instanceof Error ? error.message : String(error) });
    }
  }

  plan.downloadsUsed = budget.used;
  plan.downloadsLeft = budget.left;
  return plan;
}

export interface ApplyResult {
  path: string;
  ok: boolean;
  message: string;
}

/**
 * Downloads the accepted picks and writes each next to its video. Only paths
 * in this show, still without a subtitle, are touched — the plan came back
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
  const idByPath = new Map((await getAdminMovies({ withMediaSources: false })).map((m) => [m.Path, m.Id]));
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
    if (left !== null && left <= 0) {
      results.push({ path, ok: false, message: "Out of downloads for today." });
      continue;
    }
    try {
      const d = await downloadSubtitle(fileId);
      left = d.remaining;
      const target = `${path.slice(0, path.length - extname(path).length)}.eng.srt`;
      writeFileSync(target, d.content, "utf8");
      const itemId = idByPath.get(path);
      if (itemId) await refreshItem(itemId).catch(() => undefined);
      results.push({ path, ok: true, message: basename(target) });
    } catch (error) {
      results.push({ path, ok: false, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { results, downloadsLeft: left };
}
