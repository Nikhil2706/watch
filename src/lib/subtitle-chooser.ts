import "server-only";

import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, extname } from "node:path";

import { getAdminMovies } from "./admin-library-cache";
import { parseEpisodeInfo } from "./episode-naming";
import { getFullItem, refreshItem } from "./jellyfin";
import { getGroupedPathMap } from "./library-curation";
import { downloadSubtitle, isOpenSubtitlesConfigured, searchEpisodeSubtitles, searchMovieSubtitles } from "./opensubtitles";
import { chosenSubtitlePath, rankChoices, type RankedChoice } from "./subtitle-choices";
import type { SubtitleCandidate } from "./subtitle-match";
import { episodeIds, safeMoviehash, showIds } from "./subtitle-series";

/**
 * The film pane's Subtitles list (subtitle-choices.ts ranks it): every English
 * subtitle OpenSubtitles has for a film or an episode, searched with the
 * file's moviehash so the ones timed to it are marked, and the one the
 * curator picks downloaded next to the video. Searching spends no downloads;
 * only the pick does.
 */

const LANG = "en";
const SUB_EXTENSIONS = new Set([".srt", ".ass", ".ssa", ".vtt", ".sub"]);

export interface SubtitleChoices {
  title: string;
  path: string;
  /** Subtitle files already next to the video. */
  existingFiles: string[];
  /** Built-in subtitle tracks, by Jellyfin's count. */
  builtIn: number;
  /** For an episode: its show, so the pane can offer "match the rest of the show". */
  show: { groupId: string; name: string } | null;
  /** Best guess first (subtitle-choices.ts), each with why. */
  candidates: RankedChoice[];
}

export class ChooserError extends Error {}

function subtitleFilesNextTo(path: string): string[] {
  const stem = basename(path, extname(path));
  try {
    return readdirSync(dirname(path))
      .filter((f) => SUB_EXTENSIONS.has(extname(f).toLowerCase()) && (f.startsWith(stem + ".") || f === stem + extname(f)))
      .sort();
  } catch {
    return [];
  }
}

export async function subtitleChoices(itemId: string): Promise<SubtitleChoices> {
  if (!isOpenSubtitlesConfigured()) throw new ChooserError("OpenSubtitles isn't set up.");
  const item = await getFullItem(itemId);
  const path = typeof item.Path === "string" ? item.Path : null;
  if (!path) throw new ChooserError("This item has no file.");
  const title = typeof item.Name === "string" ? item.Name : basename(path);
  const streams = Array.isArray(item.MediaStreams) ? (item.MediaStreams as Array<{ Type?: string; IsExternal?: boolean }>) : [];
  const builtIn = streams.filter((s) => s.Type === "Subtitle" && !s.IsExternal).length;
  const hash = safeMoviehash(path);

  const group = getGroupedPathMap().get(path);
  let candidates: SubtitleCandidate[];
  if (group) {
    const parsed = parseEpisodeInfo(path);
    if (parsed.episode === null) throw new ChooserError("This episode's file name has no episode number (like S01E07) to search by.");
    const season = parsed.season ?? 1;
    const ids = showIds(group.groupId);
    const adminItem = (await getAdminMovies({ withMediaSources: false })).find((m) => m.Path === path);
    const own = episodeIds(adminItem, ids, season, parsed.episode);
    if (!ids.imdbId && !ids.tmdbId && !own.episodeImdbId && !own.episodeTmdbId) {
      throw new ChooserError("This show isn't linked to TMDB, so OpenSubtitles can't be searched for it.");
    }
    candidates = await searchEpisodeSubtitles({
      parentImdbId: ids.imdbId,
      parentTmdbId: ids.tmdbId,
      ...own,
      season,
      episode: parsed.episode,
      languages: LANG,
      moviehash: hash,
    });
  } else {
    const imdbId = (item.ProviderIds as Record<string, string> | undefined)?.Imdb;
    if (!imdbId) throw new ChooserError("This film has no IMDb id to search by. Identify it first.");
    candidates = await searchMovieSubtitles({ imdbId, languages: LANG, moviehash: hash });
  }

  return {
    title,
    path,
    existingFiles: subtitleFilesNextTo(path),
    builtIn,
    show: group ? { groupId: group.groupId, name: group.groupName } : null,
    candidates: rankChoices(candidates, basename(path)),
  };
}

/** Downloads the chosen subtitle next to the video, beside any already there. */
export async function downloadChosenSubtitle(
  itemId: string,
  fileId: number,
): Promise<{ fileName: string; downloadsLeft: number }> {
  const item = await getFullItem(itemId);
  const path = typeof item.Path === "string" ? item.Path : null;
  if (!path) throw new ChooserError("This item has no file.");
  const d = await downloadSubtitle(fileId);
  const target = chosenSubtitlePath(path, existsSync);
  writeFileSync(target, d.content, "utf8");
  await refreshItem(itemId).catch(() => undefined);
  return { fileName: basename(target), downloadsLeft: d.remaining };
}
