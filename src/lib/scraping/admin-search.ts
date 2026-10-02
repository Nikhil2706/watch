import "server-only";

import { getAdminMovies } from "../admin-library-cache";
import { adminThumbUrl } from "../admin-thumb";
import { getGroupedPathMap, getGroupSeriesId, getGroupSeriesPoster } from "../library-curation";
import { normaliseTitle } from "../library-review";
import { itemHref } from "../slugs";
import { episodeCode, episodeKey } from "../episode-key";
import { episodeTilesForPaths } from "../tmdb-view";

/**
 * A tiny admin-key-gated library search for the Accolades dashboard's
 * Builder slot search — distinct from /api/search/suggest, which requires a
 * user session (cookie auth) the curl-based admin surface doesn't have.
 *
 * A grouped TV show collapses to one hit, matched and named after the
 * show's own corrected title rather than whichever episode file Jellyfin
 * happens to iterate first — the same reasoning as collapseEpisodeGroups()
 * in media.ts, just without a Jellyfin session to call it from. A show with
 * no linked series IMDb id yet (getGroupSeriesId returns null) is skipped
 * here rather than surfaced with a dead-end id: the curator can still type
 * its raw title into a Builder slot, which resolves later the normal way.
 */
export interface AdminSearchHit {
  imdbId: string;
  name: string;
  year: number | null;
  /** "/item/{id}" for a movie, "/collection/{groupId}" for a show — lets a caller notify or link without a second lookup. */
  href: string;
  posterUrl: string | null;
  /** Episodes only, and only inside this module: season * 1000 + episode, to list them in order. */
  sort?: number;
}

export async function searchLibraryForAdmin(
  query: string,
  limit = 8,
  opts: { episodes?: boolean } = {},
): Promise<AdminSearchHit[]> {
  const key = normaliseTitle(query);
  if (!key) return [];

  // Light shape (no MediaSources) and cached: this runs on a keystroke
  // debounce, and nothing here needs a title's stream list.
  const movies = await getAdminMovies({ withMediaSources: false });
  const groupedPaths = getGroupedPathMap();
  const seenGroups = new Set<string>();
  const hits: AdminSearchHit[] = [];
  // Episodes come after the films and shows, so a show's own hit is never
  // pushed off the list by forty of its episodes.
  const episodeHits: AdminSearchHit[] = [];
  const episodeNames = opts.episodes
    ? episodeTilesForPaths(movies.filter((m) => m.Path && groupedPaths.has(m.Path)).map((m) => m.Path!))
    : null;

  for (const movie of movies) {
    if (hits.length >= limit && !opts.episodes) break;

    const g = movie.Path ? groupedPaths.get(movie.Path) : undefined;
    // One episode of a show, for a list that can hold one (a pick, a built
    // accolade). Found by the show's name, by "s02e22", or by the episode's
    // own title. A grouped file with an IMDb id of its own is a film in a
    // franchise, not an episode, and is not offered here.
    if (g && episodeNames && movie.Path && !movie.ProviderIds?.Imdb) {
      const named = episodeNames.get(movie.Path);
      const label = named
        ? `${g.groupName}: ${named.name} (${episodeCode(named.seasonNumber, named.episodeNumber)})`
        : movie.Name;
      const haystack = normaliseTitle(
        named ? `${g.groupName} s${String(named.seasonNumber).padStart(2, "0")}e${String(named.episodeNumber).padStart(2, "0")} ${named.name}` : `${g.groupName} ${movie.Name}`,
      );
      if (haystack.includes(key) && episodeHits.length < limit) {
        episodeHits.push({
          imdbId: episodeKey(movie.Path),
          name: label,
          year: null,
          href: itemHref(movie.Id, movie.Name, movie.ProductionYear),
          posterUrl: getGroupSeriesPoster(g.groupId) ?? adminThumbUrl(movie.Id, movie.ImageTags?.Primary),
          sort: named ? named.seasonNumber * 1000 + named.episodeNumber : 0,
        });
      }
    }
    if (g) {
      if (seenGroups.has(g.groupId)) continue;
      seenGroups.add(g.groupId);
      if (!normaliseTitle(g.groupName).includes(key)) continue;
      const imdbId = getGroupSeriesId(g.groupId);
      if (!imdbId) continue;
      // Best-effort only: this checks just the group's first-iterated member,
      // not every member the way browse-data.ts's full members-scan fallback
      // does (getGroupedPathMap doesn't expose a cheap members list here) —
      // fine for an admin picker that also shows a name/year caption.
      const groupPoster = getGroupSeriesPoster(g.groupId) ?? adminThumbUrl(movie.Id, movie.ImageTags?.Primary);
      hits.push({ imdbId, name: g.groupName, year: null, href: `/collection/${g.groupId}`, posterUrl: groupPoster });
      continue;
    }

    const imdbId = movie.ProviderIds?.Imdb;
    if (!imdbId) continue;
    if (!normaliseTitle(movie.Name).includes(key)) continue;
    hits.push({
      imdbId,
      name: movie.Name,
      year: movie.ProductionYear ?? null,
      href: itemHref(movie.Id, movie.Name, movie.ProductionYear),
      posterUrl: adminThumbUrl(movie.Id, movie.ImageTags?.Primary),
    });
  }
  // By show, then in broadcast order.
  const showOf = (hit: AdminSearchHit) => hit.name.slice(0, hit.name.indexOf(":"));
  episodeHits.sort((a, b) => showOf(a).localeCompare(showOf(b)) || (a.sort ?? 0) - (b.sort ?? 0));
  return [...hits, ...episodeHits.map(({ sort: _sort, ...hit }) => hit)].slice(0, limit);
}
