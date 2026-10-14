import "server-only";

import { asRows, getDb } from "./db";
import { filenameEpisodeMarker } from "./series-detect";

/**
 * Which files are episodes that no group has claimed yet.
 *
 * Until an episode is in a group it is kept out of discovery (media.ts's
 * filterVisible), the same way a damaged file is: shown as a film it reads as
 * one of sixteen identical-looking films with an episode's poster, which is
 * exactly what "Nirvanna the Band the Show" looked like. It waits in the
 * console's "Needs you" with a one-click "Group as ...", and the nightly pass
 * (series-autogroup.ts) groups most of them before anyone sees them.
 *
 * Local reads only — cheap enough for every list media.ts returns, and
 * memoised per request there.
 */
export interface EpisodeVisibilityIndex {
  /** IMDb ids OMDb says are episodes. */
  episodeImdbIds: Set<string>;
  /** Files TMDB has linked to an episode of a show. */
  tmdbEpisodePaths: Set<string>;
  /** Files in a group, which is where an episode belongs. */
  groupedPaths: Set<string>;
  /** Files the curator has said stay ungrouped (dissolved, taken out, "keep as a film"). */
  declinedPaths: Set<string>;
}

export function getEpisodeVisibilityIndex(): EpisodeVisibilityIndex {
  const db = getDb();
  return {
    episodeImdbIds: new Set(
      asRows<{ imdb_id: string }>(
        db.prepare("SELECT imdb_id FROM omdb_title_kind WHERE type = 'episode' AND series_imdb_id IS NOT NULL").all(),
      ).map((r) => r.imdb_id),
    ),
    tmdbEpisodePaths: new Set(
      asRows<{ subject_id: string }>(
        db.prepare("SELECT subject_id FROM tmdb_links WHERE subject_type = 'path' AND tmdb_kind = 'tv'").all(),
      ).map((r) => r.subject_id),
    ),
    groupedPaths: new Set(
      asRows<{ path: string }>(db.prepare("SELECT path FROM library_groups").all()).map((r) => r.path),
    ),
    declinedPaths: new Set(
      asRows<{ subject: string }>(db.prepare("SELECT subject FROM library_group_declined WHERE subject LIKE 'path:%'").all()).map(
        (r) => r.subject.slice("path:".length),
      ),
    ),
  };
}

/** A recognised episode that is in no group and that the curator has not said to keep as a film. */
export function isUngroupedEpisode(
  item: { Path?: string; ProviderIds?: Record<string, string> },
  index: EpisodeVisibilityIndex,
): boolean {
  const path = item.Path;
  if (!path) return false;
  if (index.groupedPaths.has(path) || index.declinedPaths.has(path)) return false;
  const imdb = item.ProviderIds?.Imdb;
  return (
    (!!imdb && index.episodeImdbIds.has(imdb)) || index.tmdbEpisodePaths.has(path) || filenameEpisodeMarker(path) !== null
  );
}
