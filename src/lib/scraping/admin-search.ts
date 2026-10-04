import "server-only";

import { getAdminMovies } from "../admin-library-cache";
import type { AdminMovieListItem } from "../jellyfin";
import { adminThumbUrl } from "../admin-thumb";
import { getAlternateVersionPathSet } from "../film-versions";
import {
  getAllGroupKinds,
  getExcludedPathSet,
  getGroupedPathMap,
  getGroupSeriesId,
  getGroupSeriesPoster,
} from "../library-curation";
import { normaliseTitle } from "../library-review";
import { itemHref } from "../slugs";
import { episodeCode, episodeKey } from "../episode-key";
import { episodeTilesForPaths, type EpisodeTile } from "../tmdb-view";
import { bestMatches, matchScore, type MatchScore } from "./admin-search-match";

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
  /** An IMDb id, or an episode key (episode-key.ts) for a title that is found by its file. Empty for a show with no linked series, which goes by its href. */
  imdbId: string;
  name: string;
  year: number | null;
  /** "/item/{id}" for a movie, "/collection/{groupId}" for a show — lets a caller notify or link without a second lookup. */
  href: string;
  posterUrl: string | null;
}

/** A hit while it is still being ranked. `sort` is an episode's season * 1000 + episode, to list a show in order. */
type ScoredHit = AdminSearchHit & { score: MatchScore; sort?: number };

/** With episodes on offer, films and shows stop here so they cannot crowd the episodes out, nor the reverse. */
const TITLES_BESIDE_EPISODES = 12;

/*
 * Episode names for every show file in the library, kept between keystrokes.
 *
 * Working them out reads a link per file and a season payload per season,
 * and the search did it afresh on every request — four seconds each, with
 * the box firing one per pause in typing. They change only when a show is
 * matched or a file arrives, so they are reused while the cached library
 * listing is the same one, and for no longer than that listing is itself
 * considered fresh.
 */
const EPISODE_NAMES_FRESH_MS = 60_000;
let episodeNamesMemo: { movies: AdminMovieListItem[]; builtAt: number; names: Map<string, EpisodeTile> } | null = null;

function episodeNamesFor(
  movies: AdminMovieListItem[],
  groupedPaths: ReturnType<typeof getGroupedPathMap>,
): Map<string, EpisodeTile> {
  const memo = episodeNamesMemo;
  if (memo && memo.movies === movies && Date.now() - memo.builtAt < EPISODE_NAMES_FRESH_MS) return memo.names;
  const names = episodeTilesForPaths(
    movies.filter((m) => m.Path && groupedPaths.has(m.Path)).map((m) => m.Path!),
  );
  episodeNamesMemo = { movies, builtAt: Date.now(), names };
  return names;
}

/**
 * `limit` caps the films and shows; with `episodes` it caps the episodes
 * instead, and the films and shows ahead of them stop at
 * TITLES_BESIDE_EPISODES.
 */
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
  const hits: ScoredHit[] = [];
  // Episodes come after the films and shows, so a show's own hit is never
  // pushed off the list by forty of its episodes.
  const episodeHits: ScoredHit[] = [];
  const groupKinds = getAllGroupKinds();
  const episodeNames = opts.episodes ? episodeNamesFor(movies, groupedPaths) : null;
  // Two files of one film share a title and an IMDb id, and the curator has
  // already said which the site shows: the primary of a set of cuts, or the
  // copy that was not excluded. This lists that one only. Both turning up
  // read as the same film twice, with nothing to tell them apart.
  const alternateVersions = getAlternateVersionPathSet();
  const excluded = getExcludedPathSet();

  for (const movie of movies) {
    if (movie.Path && (alternateVersions.has(movie.Path) || excluded.has(movie.Path))) continue;
    const g = movie.Path ? groupedPaths.get(movie.Path) : undefined;
    // One episode of a show, for a list that can hold one (a pick, a built
    // accolade). Found by the show's name, by "s02e22", or by the episode's
    // own title — or by any of them together, "west wing s02". A file in a
    // group of kind "movie" is a film in a franchise, not an episode, and is
    // not offered here. (An IMDb id says nothing either way: every episode
    // carries its show's.)
    if (g && episodeNames && movie.Path && groupKinds.get(g.groupId) !== "movie") {
      const named = episodeNames.get(movie.Path);
      const label = named
        ? `${g.groupName}: ${named.name} (${episodeCode(named.seasonNumber, named.episodeNumber)})`
        : movie.Name;
      const haystack = normaliseTitle(
        named ? `${g.groupName} s${String(named.seasonNumber).padStart(2, "0")}e${String(named.episodeNumber).padStart(2, "0")} ${named.name}` : `${g.groupName} ${movie.Name}`,
      );
      const score = matchScore(haystack, key);
      if (score) {
        episodeHits.push({
          imdbId: episodeKey(movie.Path),
          name: label,
          year: null,
          href: itemHref(movie.Id, movie.Name, movie.ProductionYear),
          posterUrl: getGroupSeriesPoster(g.groupId) ?? adminThumbUrl(movie.Id, movie.ImageTags?.Primary),
          score,
          sort: named ? named.seasonNumber * 1000 + named.episodeNumber : 0,
        });
      }
    }
    if (g) {
      if (seenGroups.has(g.groupId)) continue;
      seenGroups.add(g.groupId);
      const score = matchScore(normaliseTitle(g.groupName), key);
      if (!score) continue;
      // A show not yet linked to a series has no IMDb id. A pick takes a show
      // by its group (the href below), so it is offered there with an empty
      // id; the Films tab and anything else keyed on an IMDb id still skip it.
      const imdbId = getGroupSeriesId(g.groupId) ?? (opts.episodes ? "" : null);
      if (imdbId === null) continue;
      // Best-effort only: this checks just the group's first-iterated member,
      // not every member the way browse-data.ts's full members-scan fallback
      // does (getGroupedPathMap doesn't expose a cheap members list here) —
      // fine for an admin picker that also shows a name/year caption.
      const groupPoster = getGroupSeriesPoster(g.groupId) ?? adminThumbUrl(movie.Id, movie.ImageTags?.Primary);
      hits.push({ imdbId, name: g.groupName, year: null, href: `/collection/${g.groupId}`, posterUrl: groupPoster, score });
      continue;
    }

    // A film Jellyfin has no IMDb id for — a short, a recording, anything
    // the providers do not list — goes by its file instead, under the key an
    // episode uses. Only for the callers that take one: the Films tab manages
    // material that is stored against an IMDb id and has nowhere to put it.
    const imdbId = movie.ProviderIds?.Imdb ?? (opts.episodes && movie.Path ? episodeKey(movie.Path) : null);
    if (!imdbId) continue;
    const score = matchScore(normaliseTitle(movie.Name), key);
    if (!score) continue;
    hits.push({
      imdbId,
      name: movie.Name,
      year: movie.ProductionYear ?? null,
      href: itemHref(movie.Id, movie.Name, movie.ProductionYear),
      posterUrl: adminThumbUrl(movie.Id, movie.ImageTags?.Primary),
      score,
    });
  }

  const strip = ({ score: _score, sort: _sort, ...hit }: ScoredHit): AdminSearchHit => hit;
  if (!opts.episodes) return bestMatches(hits, limit).map(strip);

  // The closest episodes are chosen first and only then put by show and in
  // broadcast order, so the cut falls on the weakest matches rather than on
  // whichever seasons the library happens to list last.
  const showOf = (hit: AdminSearchHit) => hit.name.slice(0, hit.name.indexOf(":"));
  const episodes = bestMatches(episodeHits, limit).sort(
    (a, b) => showOf(a).localeCompare(showOf(b)) || (a.sort ?? 0) - (b.sort ?? 0),
  );
  return [...bestMatches(hits, Math.min(limit, TITLES_BESIDE_EPISODES)), ...episodes].map(strip);
}
