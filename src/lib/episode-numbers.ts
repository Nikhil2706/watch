import "server-only";

import { asRows, getDb, transaction } from "./db";
import { parseEpisodeInfo, type ParsedEpisode } from "./episode-naming";

/**
 * A season and episode set by hand for a file whose name has none.
 *
 * Most shows carry S01E01 in their filenames and parseEpisodeInfo reads it.
 * A collection of shorts does not: Looney Tunes is 587 files named "Duck
 * Amuck (1953) BDRip…" or "022853DVD Duck Amuck MM.avi", which sorted by
 * path put the Golden Collection's years before an alphabetical list of
 * everything else (2026-11-11). These numbers (there, season = the year,
 * episode = release order within it, season 0 the extras) take the
 * filename's place wherever a show is put in order: its page, Continue
 * watching's next episode, a channel, the episode labels and the rollout.
 * A file with a marker in its name and no number here is read as before.
 */

export type EpisodeNumberMap = ReadonlyMap<string, { season: number; episode: number }>;

export function getEpisodeNumberMap(): EpisodeNumberMap {
  const rows = asRows<{ path: string; season: number; episode: number }>(
    getDb().prepare("SELECT path, season, episode FROM library_episode_numbers").all(),
  );
  return new Map(rows.map((r) => [r.path, { season: r.season, episode: r.episode }]));
}

/** parseEpisodeInfo, with a number set here winning over the filename. */
export function episodeInfo(path: string, numbers: EpisodeNumberMap = getEpisodeNumberMap()): ParsedEpisode {
  const set = numbers.get(path);
  if (!set) return parseEpisodeInfo(path);
  return { season: set.season, episode: set.episode, title: null, sortKey: set.season * 1000 + set.episode };
}

export interface EpisodeNumberEntry {
  path: string;
  season: number;
  episode: number;
}

/** Sets (or replaces) these files' numbers in one go. */
export function setEpisodeNumbers(entries: readonly EpisodeNumberEntry[]): number {
  const now = Date.now();
  transaction((db) => {
    const put = db.prepare(
      `INSERT INTO library_episode_numbers (path, season, episode, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET season = excluded.season, episode = excluded.episode, updated_at = excluded.updated_at`,
    );
    for (const e of entries) put.run(e.path, e.season, e.episode, now);
  });
  return entries.length;
}

export function clearEpisodeNumbers(paths: readonly string[]): number {
  let n = 0;
  transaction((db) => {
    const del = db.prepare("DELETE FROM library_episode_numbers WHERE path = ?");
    for (const p of paths) n += Number(del.run(p).changes);
  });
  return n;
}
