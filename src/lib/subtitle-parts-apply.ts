import "server-only";

import { existsSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

import { getAdminMovies } from "./admin-library-cache";
import { asRows, getDb } from "./db";
import { parseEpisodeInfo } from "./episode-naming";
import { getFullItem, refreshItem } from "./jellyfin";
import { getGroupKind, getGroupSeriesId } from "./library-curation";
import { isOpenSubtitlesConfigured, searchMovieSubtitles } from "./opensubtitles";
import { formatSrt, parseSrt } from "./srt-timing";
import { chosenSubtitlePath, rankChoices, type RankedChoice } from "./subtitle-choices";
import { splitAcrossParts, uploadFitsParts, uploadKind } from "./subtitle-parts";
import { tryCandidate } from "./subtitle-try";

/**
 * Subtitles for a film kept in parts (subtitle-parts.ts has the rule). The
 * candidates are the whole film's (searched by the group's IMDb id, as a
 * film); a pick is either cut across the parts at their lengths, or, for an
 * upload that already comes one file per part, used file by file. Each
 * part's file is written next to it, beside any already there.
 */

export class PartsError extends Error {}

export interface FilmPart {
  itemId: string;
  path: string;
  label: string;
  durationMs: number;
}

export function isFilmInParts(groupId: string): boolean {
  return getGroupKind(groupId) === "movie";
}

/** The group's files in order, each with its exact length from Jellyfin. */
export async function filmParts(groupId: string): Promise<FilmPart[]> {
  const paths = asRows<{ path: string }>(getDb().prepare("SELECT path FROM library_groups WHERE group_id = ?").all(groupId)).map((r) => r.path);
  const idOf = new Map((await getAdminMovies({ withMediaSources: false })).map((m) => [m.Path, m.Id]));
  const ordered = paths
    .filter((p) => idOf.has(p))
    .map((p) => ({ p, info: parseEpisodeInfo(p) }))
    .sort((a, b) => a.info.sortKey - b.info.sortKey || a.p.localeCompare(b.p));
  const parts: FilmPart[] = [];
  for (const [i, { p }] of ordered.entries()) {
    const item = await getFullItem(idOf.get(p)!);
    const ticks = typeof item.RunTimeTicks === "number" ? item.RunTimeTicks : 0;
    parts.push({ itemId: idOf.get(p)!, path: p, label: `Part ${i + 1}`, durationMs: Math.round(ticks / 10_000) });
  }
  return parts;
}

export async function partsChoices(groupId: string): Promise<{ parts: FilmPart[]; candidates: RankedChoice[] }> {
  if (!isOpenSubtitlesConfigured()) throw new PartsError("OpenSubtitles isn't set up.");
  if (!isFilmInParts(groupId)) throw new PartsError("This isn't a film kept in parts.");
  const imdbId = getGroupSeriesId(groupId);
  if (!imdbId) throw new PartsError("This film has no IMDb id yet: link it under Show settings first.");
  const parts = await filmParts(groupId);
  if (parts.some((p) => p.durationMs <= 0)) throw new PartsError("Jellyfin doesn't know every part's length yet; try again after a library scan.");
  const found = await searchMovieSubtitles({ imdbId, languages: "en" });
  // One file per part fits exactly, so those come first; a whole-film file
  // next; an upload for one part only, or with the wrong count, last.
  const order = { split: 0, whole: 1, onePart: 2, mismatch: 3 } as const;
  const ranked = rankChoices(found, basename(parts[0]?.path ?? ""));
  return {
    parts,
    candidates: ranked
      .map((c, i) => ({ c, i, k: order[uploadKind(c.candidate, parts.length).kind] }))
      .sort((a, b) => a.k - b.k || a.i - b.i)
      .map((x) => x.c),
  };
}

/**
 * Writes a subtitle next to every part: `fileIds` is one whole-film file (cut
 * at the parts' lengths), or one file per part, in order. Each file is fetched
 * through subtitle-try.ts, so one already tried costs no download.
 */
export async function applyToParts(
  groupId: string,
  fileIds: readonly number[],
): Promise<Array<{ label: string; ok: boolean; message: string }>> {
  const parts = await filmParts(groupId);
  if (!parts.length) throw new PartsError("This film has no parts in the library.");
  let texts: string[];
  if (fileIds.length === 1) {
    const whole = parseSrt((await tryCandidate(fileIds[0]!)).text);
    if (!whole.length) throw new PartsError("That subtitle has no lines this can read.");
    texts = splitAcrossParts(whole, parts.map((p) => p.durationMs)).map((cues) => formatSrt(cues));
  } else if (uploadFitsParts(fileIds.length, parts.length)) {
    texts = [];
    for (const id of fileIds) texts.push((await tryCandidate(id)).text);
  } else {
    throw new PartsError(`That upload has ${fileIds.length} files and this film ${parts.length} parts; pick a whole-film one instead.`);
  }
  const out = [];
  for (const [k, part] of parts.entries()) {
    const text = texts[k] ?? "";
    if (!parseSrt(text).length) {
      out.push({ label: part.label, ok: false, message: "No lines fall in this part." });
      continue;
    }
    try {
      const target = chosenSubtitlePath(part.path, existsSync);
      writeFileSync(target, text, "utf8");
      await refreshItem(part.itemId).catch(() => undefined);
      out.push({ label: part.label, ok: true, message: basename(target) });
    } catch (error) {
      out.push({ label: part.label, ok: false, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return out;
}
