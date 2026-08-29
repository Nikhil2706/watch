import "server-only";

import { decadeOf, type BrowseSort } from "./browse-filters";
import { asRow, getDb } from "./db";
import {
  getAllGroupSeriesPosters,
  getGroupSeriesId,
  getGroupSeriesMeta,
} from "./library-curation";
import {
  diversityDiscount,
  getAllMovies,
  getPeopleForAllMovies,
  posterUrl,
  splitByGroup,
  type MediaItem,
  type PersonCredit,
} from "./media";
import { getCachedRatingsBulk, getRatings } from "./ratings";
import type { ResolvedSession } from "./session";
import { itemHref } from "./slugs";

/**
 * Server-side assembly for the multi-dimensional Browse page (genre /
 * director / actor / decade, ranked by a Bayesian-weighted popularity
 * score) — ported from the design mockup's client-side JS into real data,
 * with the two rules that didn't exist when the mockup was built:
 *
 * 1. Hidden files: getAllMoviesForBrowse() already excludes them (same
 *    filterVisible() every other catalogue read goes through).
 * 2. TV show grouping: a grouped show becomes ONE entry here, using its
 *    series-level genres/cast/director (getGroupSeriesMeta) and series
 *    rating (via its linked IMDb id), never one entry per episode — an
 *    episode-level entry per group member would count a show's director
 *    once per episode instead of once, which is exactly the "franchise
 *    inflation" bug the popularity ranking below already goes out of its
 *    way to avoid for movie franchises.
 *
 * BrowseMovie wraps rather than replaces MediaItem so the grid can keep
 * using the real PosterCard component (watched badge, resume bar,
 * favourite/rewatch buttons) unmodified — a group just carries a synthetic
 * pseudo-item the same way the pre-redesign Browse page already did.
 */

export interface BrowseMovie {
  item: MediaItem;
  href: string;
  /** Explicit override for PosterCard's posterSrc — only set for a group (its series poster); a plain movie leaves this undefined and PosterCard derives the poster from item.ImageTags itself. */
  poster: string | undefined;
  year: number | null;
  genres: string[];
  directors: string[];
  actors: string[];
  imdbRating: number | null;
  imdbVotes: number | null;
  communityRating: number | null;
  seen: boolean;
  isGroup: boolean;
  partsCount?: number;
}

export interface BrowseCatalogue {
  movies: BrowseMovie[];
  libraryMeanRating: number;
}

function toBrowseMovie(
  item: MediaItem,
  ratings: Map<string, { imdbRating: number | null; imdbVotes: number | null }>,
): BrowseMovie {
  const imdbId = item.ProviderIds?.Imdb;
  const cached = imdbId ? ratings.get(imdbId) : undefined;
  return {
    item,
    href: itemHref(item.Id, item.Name, item.ProductionYear),
    poster: undefined,
    year: item.ProductionYear ?? null,
    genres: item.Genres ?? [],
    directors: (item.People ?? []).filter((p) => p.Type === "Director").map((p) => p.Name),
    actors: (item.People ?? []).filter((p) => p.Type === "Actor").map((p) => p.Name),
    imdbRating: cached?.imdbRating ?? null,
    imdbVotes: cached?.imdbVotes ?? null,
    communityRating: item.CommunityRating ?? null,
    seen: item.UserData?.Played ?? false,
    isGroup: false,
  };
}

async function buildBrowseCatalogue(allItems: MediaItem[]): Promise<BrowseCatalogue> {
  const { ungrouped, groups } = splitByGroup(allItems);

  const imdbIds = ungrouped.map((i) => i.ProviderIds?.Imdb).filter((id): id is string => !!id);
  const ratings = getCachedRatingsBulk(imdbIds);

  const movies: BrowseMovie[] = ungrouped.map((item) => toBrowseMovie(item, ratings));

  const seriesPosters = getAllGroupSeriesPosters();
  const groupMovies = await Promise.all(
    groups.map(async (g): Promise<BrowseMovie> => {
      const meta = getGroupSeriesMeta(g.groupId);
      const seriesImdbId = getGroupSeriesId(g.groupId);
      // One lookup per GROUP, not per episode — groups are a handful, not
      // hundreds, so this stays a small, bounded (and cached) set of calls.
      const seriesRatings = seriesImdbId ? await getRatings(seriesImdbId).catch(() => null) : null;
      const withPoster = g.members.find((m) => posterUrl(m));
      // A show's episodes were individually OMDb-enriched, so each still
      // carries its own year/genres — falling back to the earliest member
      // when series meta hasn't been filled in yet keeps the group from
      // vanishing off decade/genre facets entirely in the meantime.
      const first = g.members[0];
      // "Seen" for a show reads as "finished watching it" — every episode played.
      const seen = g.members.every((m) => m.UserData?.Played);
      // Carried on the pseudo-item too, not just on the BrowseMovie beside it:
      // a group has no Jellyfin item of its own, so anything rendering it from
      // `item` alone (PosterCard's watched badge) would otherwise read a show
      // with no UserData at all as permanently unwatched.
      const pseudoItem: MediaItem = {
        Id: g.groupId,
        Name: g.groupName,
        Type: "Group",
        UserData: { Played: seen },
      };

      return {
        item: pseudoItem,
        href: `/collection/${g.groupId}`,
        poster: seriesPosters.get(g.groupId) ?? (withPoster ? (posterUrl(withPoster) ?? undefined) : undefined),
        year: first?.ProductionYear ?? null,
        genres: meta && meta.genres.length > 0 ? meta.genres : (first?.Genres ?? []),
        directors: meta?.director ?? [],
        actors: meta?.actors ?? [],
        imdbRating: seriesRatings?.imdb ? Number.parseFloat(seriesRatings.imdb) : null,
        imdbVotes: seriesRatings?.imdbVotes ? Number.parseInt(seriesRatings.imdbVotes.replace(/,/g, ""), 10) : null,
        communityRating: first?.CommunityRating ?? null,
        seen,
        isGroup: true,
        partsCount: g.members.length,
      };
    }),
  );

  movies.push(...groupMovies);

  const rated = movies.filter((m) => m.imdbRating != null);
  const libraryMeanRating =
    rated.length > 0 ? rated.reduce((sum, m) => sum + (m.imdbRating ?? 0), 0) / rated.length : 7;

  return { movies, libraryMeanRating };
}

/* ------------------------------------------------------------------ *
 * Popularity — a Bayesian weighted rating (the same formula IMDb's own
 * Top 250 uses), not a bare average. A bare average is what lets a niche
 * title with one perfect vote outrank a well-known film with thousands of
 * good-not-great ones; mixing rating with confidence fixes that.
 *
 *   WR = (v / (v + M)) * R  +  (M / (v + M)) * C
 *
 *   R = the film's own rating, v = its vote count, C = the library-wide
 *   mean, M = how many votes it takes before a film's own rating starts to
 *   dominate C.
 * ------------------------------------------------------------------ */

const VOTE_WEIGHT_M = 5000;
const ASSUMED_FALLBACK_VOTES = 200;
const SEEN_PENALTY = 0.85;

export function basePopularity(movie: BrowseMovie, libraryMeanRating: number): number {
  if (movie.imdbRating != null && movie.imdbVotes != null) {
    const v = movie.imdbVotes;
    return (v / (v + VOTE_WEIGHT_M)) * movie.imdbRating + (VOTE_WEIGHT_M / (v + VOTE_WEIGHT_M)) * libraryMeanRating;
  }
  if (movie.communityRating != null) {
    const v = ASSUMED_FALLBACK_VOTES;
    return (v / (v + VOTE_WEIGHT_M)) * movie.communityRating + (VOTE_WEIGHT_M / (v + VOTE_WEIGHT_M)) * libraryMeanRating;
  }
  return libraryMeanRating;
}

export function popularityScore(movie: BrowseMovie, libraryMeanRating: number): number {
  const base = basePopularity(movie, libraryMeanRating);
  return movie.seen ? base * SEEN_PENALTY : base;
}

// Re-exported so page.tsx keeps its single import site for Browse concerns,
// while the logic itself stays in a dependency-free, testable module.
export { decadeOf, facetLinkValue, filterMovies, isFacetSelected, parseDecade } from "./browse-filters";
export type { BrowseDim, BrowseSort, FilterableMovie } from "./browse-filters";

export interface FacetValue {
  id: string;
  name: string;
  count: number;
}

export function genreCounts(movies: BrowseMovie[], libraryMeanRating: number): FacetValue[] {
  const counts = new Map<string, number>();
  const sums = new Map<string, number>();
  for (const m of movies) {
    const pop = basePopularity(m, libraryMeanRating);
    for (const g of m.genres) {
      counts.set(g, (counts.get(g) ?? 0) + 1);
      sums.set(g, (sums.get(g) ?? 0) + pop);
    }
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ id: name, name, count, avg: (sums.get(name) ?? 0) / count }))
    .sort((a, b) => b.avg - a.avg)
    .map(({ id, name, count }) => ({ id, name, count }));
}

export function decadeCounts(movies: BrowseMovie[]): FacetValue[] {
  const counts = new Map<number, number>();
  for (const m of movies) {
    const d = decadeOf(m.year);
    if (d != null) counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([decade, count]) => ({ id: String(decade), name: `${decade}s`, count }));
}

/**
 * Director/actor ranking by a diminishing-returns sum of popularity ABOVE
 * the library mean. A plain sum collapses into ranking by film count (most
 * films cluster near the mean, so sum ≈ count × mean); summing only the
 * EXCESS over the mean fixed that, until a person with several entries in
 * the same franchise let credits stack up on volume from one thing rather
 * than genuine range. Ranking each person's own films by excess and
 * halving the weight of each successive one (1×, ½×, ¼×, ⅛×…) means a 4th
 * film from the same franchise barely moves the needle, while two
 * genuinely standout films from different things can still outrank four
 * good-but-same-series ones — and a true one-hit-wonder still gets full,
 * undiscounted credit for their one film.
 */
const RANK_DECAY = 0.5;

export interface PersonFacet {
  name: string;
  /** A real Jellyfin person id if this person was ever credited on a plain movie (not just a group's series-level meta, which only carries names); enables linking to their bio. Falls back to the name itself. */
  id: string;
  photo: string | null;
  directorCount: number;
  actorCount: number;
  popularity: number;
}

function personFacets(
  movies: BrowseMovie[],
  role: "directors" | "actors",
  peopleById: Map<string, { id: string; photo: string | null }>,
  libraryMeanRating: number,
): PersonFacet[] {
  const excessByName = new Map<string, number[]>();
  const directorCountByName = new Map<string, number>();
  const actorCountByName = new Map<string, number>();

  for (const m of movies) {
    const excess = basePopularity(m, libraryMeanRating) - libraryMeanRating;
    for (const name of m.directors) {
      directorCountByName.set(name, (directorCountByName.get(name) ?? 0) + 1);
      if (role === "directors") {
        if (!excessByName.has(name)) excessByName.set(name, []);
        excessByName.get(name)!.push(excess);
      }
    }
    for (const name of m.actors) {
      actorCountByName.set(name, (actorCountByName.get(name) ?? 0) + 1);
      if (role === "actors") {
        if (!excessByName.has(name)) excessByName.set(name, []);
        excessByName.get(name)!.push(excess);
      }
    }
  }

  const facets: PersonFacet[] = [];
  for (const [name, values] of excessByName) {
    const sorted = [...values].sort((a, b) => b - a);
    let score = 0;
    let weight = 1;
    for (const v of sorted) {
      score += v * weight;
      weight *= RANK_DECAY;
    }
    const known = peopleById.get(name);
    facets.push({
      name,
      id: known?.id ?? name,
      photo: known?.photo ?? null,
      directorCount: directorCountByName.get(name) ?? 0,
      actorCount: actorCountByName.get(name) ?? 0,
      popularity: score,
    });
  }
  return facets.sort((a, b) => b.popularity - a.popularity || a.name.localeCompare(b.name));
}

/** Maps a person's name to their real Jellyfin id/photo wherever a plain (non-group) movie credit reveals one — group series-meta only ever carries plain names. */
function indexKnownPeople(allItems: MediaItem[]): Map<string, { id: string; photo: string | null }> {
  const map = new Map<string, { id: string; photo: string | null }>();
  for (const item of allItems) {
    for (const p of item.People ?? []) {
      if (p.Type !== "Director" && p.Type !== "Actor") continue;
      if (map.has(p.Name)) continue;
      map.set(p.Name, {
        id: p.Id,
        // Displayed at 24x24 CSS px (.value-row .avatar in globals.css) — 48
        // is already 2x for retina; the old 200 asked Jellyfin to generate
        // and cache a variant over 8x larger than anything on screen needs.
        photo: p.PrimaryImageTag
          ? `/jf/Items/${p.Id}/Images/Primary?fillWidth=48&fillHeight=48&quality=90&tag=${p.PrimaryImageTag}`
          : null,
      });
    }
  }
  return map;
}

export interface BrowseFacets {
  genres: FacetValue[];
  decades: FacetValue[];
  directors: PersonFacet[];
  actors: PersonFacet[];
}

function buildBrowseFacets(allItems: MediaItem[], catalogue: BrowseCatalogue): BrowseFacets {
  const peopleById = indexKnownPeople(allItems);

  return {
    genres: genreCounts(catalogue.movies, catalogue.libraryMeanRating),
    decades: decadeCounts(catalogue.movies),
    directors: personFacets(catalogue.movies, "directors", peopleById, catalogue.libraryMeanRating),
    actors: personFacets(catalogue.movies, "actors", peopleById, catalogue.libraryMeanRating),
  };
}

export interface BrowseData {
  catalogue: BrowseCatalogue;
  facets: BrowseFacets;
}

/**
 * getPeopleForAllMovies() alone costs ~20 seconds against Jellyfin,
 * confirmed by direct measurement against this session's own library and
 * independent of caching at this layer — it's Jellyfin's own cost to
 * resolve People across the whole catalogue, not something request shaping
 * fixes. So it's paid rarely: cached in SQLite (browse_people_cache, a
 * singleton row), not in-memory — an in-memory cache resets on every
 * redeploy, which is exactly what turned "slow once" into "slow again on
 * every restart" during testing. Cast credits change close to never, so a
 * long TTL is the right trade: fresher data isn't worth a 20-second page
 * load.
 */
const PEOPLE_CACHE_TTL_MS = 12 * 60 * 60 * 1000;

interface PeopleCacheRow {
  data: string;
  fetched_at: number;
}

function readPeopleCache(): Map<string, PersonCredit[]> | null {
  const row = asRow<PeopleCacheRow>(
    getDb().prepare("SELECT data, fetched_at FROM browse_people_cache WHERE id = 1").get(),
  );
  if (!row) return null;
  if (Date.now() - row.fetched_at > PEOPLE_CACHE_TTL_MS) return null;
  return new Map(Object.entries(JSON.parse(row.data) as Record<string, PersonCredit[]>));
}

function writePeopleCache(map: Map<string, PersonCredit[]>): void {
  getDb()
    .prepare(
      `INSERT INTO browse_people_cache (id, data, fetched_at) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at`,
    )
    .run(JSON.stringify(Object.fromEntries(map)), Date.now());
}

/**
 * Called once at boot (see instrumentation.ts), fire-and-forget, so the
 * ~20-second cost lands during startup instead of on whoever happens to
 * load Browse first after a restart or once the 12-hour TTL lapses. Skips
 * the fetch entirely when the cache is already warm, so a routine restart
 * doesn't re-pay a cost that hasn't actually gone stale.
 */
export async function warmBrowsePeopleCache(): Promise<void> {
  if (readPeopleCache()) return;
  const { getPeopleForAllMoviesAdmin } = await import("./jellyfin");
  const fresh = await getPeopleForAllMoviesAdmin();
  writePeopleCache(fresh);
}

async function getPeopleIndex(session: ResolvedSession): Promise<Map<string, PersonCredit[]>> {
  const cached = readPeopleCache();
  if (cached) return cached;
  const fresh = await getPeopleForAllMovies(session);
  writePeopleCache(fresh);
  return fresh;
}

// The movie list itself (genres, ratings, "seen" status) is cheap —
// confirmed at under a second against this library — and stays per-request
// rather than cached, since "seen" is per-user and changes with every
// watch. Only the expensive part (People) is cached, and cached globally in
// SQLite: cast credits aren't user-specific the way watch history is, so
// unlike an earlier in-memory attempt at this, there's no per-user leakage
// risk in sharing it.
/** The one entry point page.tsx calls. */
export async function buildBrowseData(session: ResolvedSession): Promise<BrowseData> {
  const [allItems, peopleIndex] = await Promise.all([
    getAllMovies(session, { limit: 2000 }),
    getPeopleIndex(session),
  ]);
  for (const item of allItems) {
    item.People = peopleIndex.get(item.Id) ?? [];
  }

  const catalogue = await buildBrowseCatalogue(allItems);
  const facets = buildBrowseFacets(allItems, catalogue);
  return { catalogue, facets };
}

// BrowseDim/BrowseSort/filterMovies now live in ./browse-filters (re-exported
// at the top of this file) so they can be unit-tested without dragging in
// server-only and the SQLite handle.

/**
 * Diminishing-returns discount for "popularity" sort, so one heavily
 * represented director doesn't crowd the whole top of the list — a thin
 * BrowseMovie-shaped wrapper around media.ts's diversityDiscount(), the
 * same generic helper getSimilar() there uses for "More like this". Caught
 * live: 8 of the top 10 "Popular" results were the same director.
 */
function directorDiversityDiscount(movies: BrowseMovie[], libraryMeanRating: number): Map<string, number> {
  return diversityDiscount(
    movies,
    (m) => m.directors,
    (m) => popularityScore(m, libraryMeanRating),
    (m) => m.item.Id,
  );
}

export function sortMovies(movies: BrowseMovie[], sort: BrowseSort, libraryMeanRating: number): BrowseMovie[] {
  const copy = [...movies];
  if (sort === "newest") copy.sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
  else if (sort === "oldest") copy.sort((a, b) => (a.year ?? 0) - (b.year ?? 0));
  else {
    const discount = directorDiversityDiscount(movies, libraryMeanRating);
    const adjusted = (m: BrowseMovie) => popularityScore(m, libraryMeanRating) * (discount.get(m.item.Id) ?? 1);
    copy.sort((a, b) => adjusted(b) - adjusted(a));
  }
  return copy;
}
