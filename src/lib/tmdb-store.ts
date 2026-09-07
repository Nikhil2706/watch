import "server-only";

import { asRow, asRows, getDb } from "./db";
import { recordExternalApiCall } from "./events";
import { env } from "./env";

/**
 * TMDB, fetched once and kept.
 *
 * Two things drove this shape.
 *
 * First, the raw payload is stored verbatim. A new use of TMDB data — episode
 * stills today, recommendations or cinematographers tomorrow — should cost a
 * SQL read, not another round trip. Storing only the fields we happen to want
 * this week guarantees re-fetching the whole library the next time someone has
 * an idea.
 *
 * Second, this host reaches TMDB badly: repeated ECONNRESET on first calls, and
 * one request in thirty failing outright after retries during a measured burst.
 * That makes every avoided call worth real time, and it is why the TV path
 * below fetches a SEASON rather than an episode — one request returns every
 * episode in it, so The West Wing's 154 episodes cost 7 calls instead of 154.
 *
 * TMDB itself imposes no daily quota (their rate-limiting docs record the
 * legacy 40-per-10s cap as disabled since 2019, leaving an unpublished ceiling
 * around 40/s). The budget in tmdb-backfill.ts is therefore about this link's
 * reliability, not about being cut off.
 */

const BASE_URL = "https://api.themoviedb.org/3";

export type TmdbKind = "movie" | "tv" | "season" | "collection";

export interface CachedTmdb<T = unknown> {
  kind: TmdbKind;
  tmdbId: number;
  season: number;
  imdbId: string | null;
  payload: T;
  fetchedAt: number;
}

/** No season/episode is stored as -1: SQLite NULLs are not equal, so a NULL key would not constrain. */
const NONE = -1;

interface CacheRow {
  kind: string;
  tmdb_id: number;
  season: number;
  episode: number;
  imdb_id: string | null;
  payload: string;
  fetched_at: number;
}

function toCached<T>(row: CacheRow): CachedTmdb<T> | null {
  try {
    return {
      kind: row.kind as TmdbKind,
      tmdbId: row.tmdb_id,
      season: row.season,
      imdbId: row.imdb_id,
      payload: JSON.parse(row.payload) as T,
      fetchedAt: row.fetched_at,
    };
  } catch {
    // A payload that will not parse is a corrupt row, not a reason to throw at
    // a caller who only wanted a poster. Treated as a miss so it refetches.
    return null;
  }
}

export function getCached<T = unknown>(kind: TmdbKind, tmdbId: number, season = NONE): CachedTmdb<T> | null {
  const row = asRow<CacheRow>(
    getDb()
      .prepare("SELECT * FROM tmdb_cache WHERE kind = ? AND tmdb_id = ? AND season = ? AND episode = ?")
      .get(kind, tmdbId, season, NONE),
  );
  return row ? toCached<T>(row) : null;
}

export function putCached(
  kind: TmdbKind,
  tmdbId: number,
  payload: unknown,
  options: { season?: number; imdbId?: string | null } = {},
): void {
  getDb()
    .prepare(
      `INSERT INTO tmdb_cache (kind, tmdb_id, season, episode, imdb_id, payload, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(kind, tmdb_id, season, episode)
       DO UPDATE SET imdb_id = excluded.imdb_id, payload = excluded.payload, fetched_at = excluded.fetched_at`,
    )
    .run(kind, tmdbId, options.season ?? NONE, NONE, options.imdbId ?? null, JSON.stringify(payload), Date.now());
}

/* ------------------------------------------------------------------ *
 * Fetching
 * ------------------------------------------------------------------ */

export class TmdbStoreError extends Error {}

/**
 * One TMDB request, retried on transport failure only.
 *
 * Every call is recorded in external_api_calls. TMDB was the one upstream this
 * app talked to without logging it, so its usage was invisible next to OMDb's
 * and the scrapers' — which is exactly the thing you want to see before running
 * a library-scale backfill, not after.
 */
async function fetchJson<T>(path: string): Promise<T> {
  if (!env.tmdbReadAccessToken) throw new TmdbStoreError("TMDB_READ_ACCESS_TOKEN is not configured.");

  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(`${BASE_URL}${path}`, {
        headers: {
          Authorization: `Bearer ${env.tmdbReadAccessToken}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(15_000),
        cache: "no-store",
      });
      if (!response.ok) {
        // A 4xx is TMDB answering. Retrying asks the same wrong question again.
        recordExternalApiCall("tmdb", false);
        throw new TmdbStoreError(`TMDB ${path} returned ${response.status}`);
      }
      recordExternalApiCall("tmdb", true);
      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof TmdbStoreError) throw error;
      lastError = error;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  recordExternalApiCall("tmdb", false);
  throw new TmdbStoreError(
    `Could not reach TMDB after 3 attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

/**
 * Everything about a film, in one request.
 *
 * append_to_response bundles credits, keywords, images, recommendations and the
 * rest into the same call, so pulling five kinds of data costs exactly what
 * pulling one does. On this connection that is the difference that matters.
 */
const MOVIE_APPEND =
  "credits,keywords,images,videos,recommendations,similar,alternative_titles,external_ids,release_dates";

export async function fetchMovie(tmdbId: number, force = false): Promise<CachedTmdb> {
  if (!force) {
    const hit = getCached("movie", tmdbId);
    if (hit) return hit;
  }
  const payload = await fetchJson<{ imdb_id?: string; external_ids?: { imdb_id?: string } }>(
    `/movie/${tmdbId}?append_to_response=${MOVIE_APPEND}&include_image_language=en,null`,
  );
  const imdbId = payload.imdb_id ?? payload.external_ids?.imdb_id ?? null;
  putCached("movie", tmdbId, payload, { imdbId });
  return { kind: "movie", tmdbId, season: NONE, imdbId, payload, fetchedAt: Date.now() };
}

export async function fetchShow(tmdbId: number, force = false): Promise<CachedTmdb> {
  if (!force) {
    const hit = getCached("tv", tmdbId);
    if (hit) return hit;
  }
  const payload = await fetchJson<{ external_ids?: { imdb_id?: string } }>(
    `/tv/${tmdbId}?append_to_response=external_ids,credits,keywords,images&include_image_language=en,null`,
  );
  const imdbId = payload.external_ids?.imdb_id ?? null;
  putCached("tv", tmdbId, payload, { imdbId });
  return { kind: "tv", tmdbId, season: NONE, imdbId, payload, fetchedAt: Date.now() };
}

export interface TmdbEpisode {
  episode_number: number;
  season_number: number;
  name: string;
  overview: string;
  air_date: string | null;
  runtime: number | null;
  still_path: string | null;
  vote_average: number;
}

/**
 * A whole season, which is where the efficiency is.
 *
 * One request returns every episode in the season with its still, name,
 * overview and air date. Fetching per episode would multiply this library's
 * 628 episode files into 628 calls against a link that drops one in thirty.
 */
export async function fetchSeason(tmdbId: number, season: number, force = false): Promise<TmdbEpisode[]> {
  if (!force) {
    const hit = getCached<{ episodes?: TmdbEpisode[] }>("season", tmdbId, season);
    if (hit) return hit.payload.episodes ?? [];
  }
  const payload = await fetchJson<{ episodes?: TmdbEpisode[] }>(`/tv/${tmdbId}/season/${season}`);
  putCached("season", tmdbId, payload, { season });
  return payload.episodes ?? [];
}

/**
 * Search results, plural and unranked.
 *
 * Returning the first result was how E.R. got linked to Trauma: Life in the
 * E.R. The caller ranks these with tmdb-match.ts, which needs to see the field
 * rather than be handed a decision. Note /search/tv does NOT include episode
 * counts, so the caller has to fetch the detail of a candidate it is serious
 * about before it can judge the fit.
 */
export async function searchShows(
  name: string,
): Promise<Array<{ id: number; name: string; year: number | null }>> {
  const data = await fetchJson<{ results?: Array<{ id: number; name: string; first_air_date?: string }> }>(
    `/search/tv?query=${encodeURIComponent(name)}`,
  );
  return (data.results ?? []).map((r) => ({
    id: r.id,
    name: r.name,
    year: r.first_air_date ? Number(r.first_air_date.slice(0, 4)) : null,
  }));
}

export async function findByImdbId(imdbId: string): Promise<{ kind: "movie" | "tv"; id: number } | null> {
  const data = await fetchJson<{
    movie_results?: Array<{ id: number }>;
    tv_results?: Array<{ id: number }>;
  }>(`/find/${encodeURIComponent(imdbId)}?external_source=imdb_id`);
  const movie = (data.movie_results ?? [])[0];
  if (movie) return { kind: "movie", id: movie.id };
  const tv = (data.tv_results ?? [])[0];
  return tv ? { kind: "tv", id: tv.id } : null;
}

/* ------------------------------------------------------------------ *
 * Links: what a thing in this library is, over in TMDB
 * ------------------------------------------------------------------ */

export interface TmdbLink {
  subjectType: "path" | "group";
  subjectId: string;
  tmdbKind: "movie" | "tv";
  tmdbId: number;
  season: number | null;
  episode: number | null;
  resolvedBy: string;
}

export function putLink(link: TmdbLink): void {
  getDb()
    .prepare(
      `INSERT INTO tmdb_links (subject_type, subject_id, tmdb_kind, tmdb_id, season, episode, resolved_by, linked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(subject_type, subject_id)
       DO UPDATE SET tmdb_kind = excluded.tmdb_kind, tmdb_id = excluded.tmdb_id,
                     season = excluded.season, episode = excluded.episode,
                     resolved_by = excluded.resolved_by, linked_at = excluded.linked_at`,
    )
    .run(
      link.subjectType,
      link.subjectId,
      link.tmdbKind,
      link.tmdbId,
      link.season,
      link.episode,
      link.resolvedBy,
      Date.now(),
    );
}

export function getLink(subjectType: "path" | "group", subjectId: string): TmdbLink | null {
  const row = asRow<{
    subject_type: string;
    subject_id: string;
    tmdb_kind: string;
    tmdb_id: number;
    season: number | null;
    episode: number | null;
    resolved_by: string;
  }>(
    getDb()
      .prepare("SELECT * FROM tmdb_links WHERE subject_type = ? AND subject_id = ?")
      .get(subjectType, subjectId),
  );
  if (!row) return null;
  return {
    subjectType: row.subject_type as "path" | "group",
    subjectId: row.subject_id,
    tmdbKind: row.tmdb_kind as "movie" | "tv",
    tmdbId: row.tmdb_id,
    season: row.season,
    episode: row.episode,
    resolvedBy: row.resolved_by,
  };
}

export interface TmdbStoreStats {
  movies: number;
  shows: number;
  seasons: number;
  links: number;
  oldestFetch: number | null;
}

export function tmdbStoreStats(): TmdbStoreStats {
  const counts = asRows<{ kind: string; n: number }>(
    getDb().prepare("SELECT kind, COUNT(*) AS n FROM tmdb_cache GROUP BY kind").all(),
  );
  const by = Object.fromEntries(counts.map((c) => [c.kind, c.n]));
  const oldest = asRow<{ t: number | null }>(
    getDb().prepare("SELECT MIN(fetched_at) AS t FROM tmdb_cache").get(),
  );
  const links = asRow<{ n: number }>(getDb().prepare("SELECT COUNT(*) AS n FROM tmdb_links").get());
  return {
    movies: by.movie ?? 0,
    shows: by.tv ?? 0,
    seasons: by.season ?? 0,
    links: links?.n ?? 0,
    oldestFetch: oldest?.t ?? null,
  };
}

/** TMDB image base. w780 for stills is a good balance of sharp and small on this box. */
export function tmdbImage(path: string | null | undefined, size = "w780"): string | null {
  return path ? `https://image.tmdb.org/t/p/${size}${path}` : null;
}
