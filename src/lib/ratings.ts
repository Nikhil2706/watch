import "server-only";

import { asRow, getDb } from "./db";

/**
 * External ratings via OMDb.
 *
 * One request returns IMDb, Rotten Tomatoes and Metacritic together, keyed on
 * the IMDb id Jellyfin already stores against each film — so no matching or
 * scraping is needed.
 *
 * LETTERBOXD IS DELIBERATELY ABSENT. It has no public API; the only route is
 * scraping their pages, which breaks whenever their markup changes and is
 * against their terms. An omission is better than a field that silently goes
 * stale or wrong.
 */

const OMDB_ENDPOINT = "https://www.omdbapi.com/";

/**
 * OMDb's free tier allows 1000 requests a day. A home page render touches every
 * visible title, so without caching a few page loads would exhaust it. Ratings
 * move slowly; a week-old number is fine.
 */
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface Ratings {
  imdb: string | null;
  imdbVotes: string | null;
  rotten: string | null;
  metacritic: string | null;
  /** True when these came from cache rather than a fresh call. */
  cached: boolean;
}

interface CacheRow {
  imdb_id: string;
  imdb_rating: string | null;
  imdb_votes: string | null;
  rotten: string | null;
  metacritic: string | null;
  fetched_at: number;
}

function readCache(imdbId: string): CacheRow | undefined {
  return asRow<CacheRow>(
    getDb().prepare("SELECT * FROM rating_cache WHERE imdb_id = ?").get(imdbId),
  );
}

function writeCache(imdbId: string, ratings: Omit<Ratings, "cached">): void {
  getDb()
    .prepare(
      `INSERT INTO rating_cache (imdb_id, imdb_rating, imdb_votes, rotten, metacritic, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(imdb_id) DO UPDATE SET
         imdb_rating = excluded.imdb_rating,
         imdb_votes  = excluded.imdb_votes,
         rotten      = excluded.rotten,
         metacritic  = excluded.metacritic,
         fetched_at  = excluded.fetched_at`,
    )
    .run(
      imdbId,
      ratings.imdb,
      ratings.imdbVotes,
      ratings.rotten,
      ratings.metacritic,
      Date.now(),
    );
}

/**
 * Ratings for one IMDb id, cached.
 *
 * Returns null when there is no API key or the lookup fails — the caller shows
 * whatever Jellyfin already knows instead. A missing ratings row is a much
 * better outcome than a broken page.
 */
export async function getRatings(imdbId: string | undefined): Promise<Ratings | null> {
  if (!imdbId) return null;

  const cached = readCache(imdbId);
  if (cached && Date.now() - cached.fetched_at < CACHE_TTL_MS) {
    return {
      imdb: cached.imdb_rating,
      imdbVotes: cached.imdb_votes,
      rotten: cached.rotten,
      metacritic: cached.metacritic,
      cached: true,
    };
  }

  const key = process.env.OMDB_API_KEY?.trim();
  if (!key) {
    // Serve a stale entry rather than nothing if the key is later removed.
    if (cached) {
      return {
        imdb: cached.imdb_rating,
        imdbVotes: cached.imdb_votes,
        rotten: cached.rotten,
        metacritic: cached.metacritic,
        cached: true,
      };
    }
    return null;
  }

  try {
    const url = `${OMDB_ENDPOINT}?i=${encodeURIComponent(imdbId)}&apikey=${encodeURIComponent(key)}`;
    const response = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`OMDb ${response.status}`);

    const data = (await response.json()) as {
      Response?: string;
      Error?: string;
      imdbRating?: string;
      imdbVotes?: string;
      Metascore?: string;
      Ratings?: Array<{ Source: string; Value: string }>;
    };

    if (data.Response === "False") throw new Error(data.Error ?? "OMDb error");

    const na = (value: string | undefined) =>
      !value || value === "N/A" ? null : value;

    const rotten =
      na(data.Ratings?.find((r) => r.Source === "Rotten Tomatoes")?.Value) ?? null;

    const ratings = {
      imdb: na(data.imdbRating),
      imdbVotes: na(data.imdbVotes),
      rotten,
      metacritic: na(data.Metascore),
    };

    writeCache(imdbId, ratings);
    return { ...ratings, cached: false };
  } catch (error) {
    console.warn(`[ratings] OMDb lookup failed for ${imdbId}:`, error);
    // Stale beats absent.
    if (cached) {
      return {
        imdb: cached.imdb_rating,
        imdbVotes: cached.imdb_votes,
        rotten: cached.rotten,
        metacritic: cached.metacritic,
        cached: true,
      };
    }
    return null;
  }
}
