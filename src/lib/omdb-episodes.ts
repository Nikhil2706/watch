import "server-only";

import { logEvent, recordExternalApiCall } from "./events";

/**
 * Series and per-episode metadata via OMDb.
 *
 * Jellyfin matched these files one at a time as standalone movies, so their
 * title/overview/poster/cast are often for the wrong thing entirely. OMDb's
 * i=<seriesImdbId>[&Season=&Episode=] lookup returns the real title's Title,
 * Plot, Poster, Genre, Director, Writer, Actors and rating in one call — the
 * same OMDb key already configured for ratings (ratings.ts), no separate
 * TMDB signup needed.
 */

const OMDB_ENDPOINT = "https://www.omdbapi.com/";

function na(value: string | undefined): string | null {
  return !value || value === "N/A" ? null : value;
}

/** "Emma Stone, Nathan Fielder, Benny Safdie" -> ["Emma Stone", "Nathan Fielder", "Benny Safdie"]. Empty/"N/A" -> []. */
function names(value: string | undefined): string[] {
  const clean = na(value);
  if (!clean) return [];
  return clean.split(",").map((s) => s.trim()).filter(Boolean);
}

interface OmdbCredits {
  genres: string[];
  actors: string[];
  director: string[];
  writer: string[];
  /** OMDb's raw rating string, e.g. "7.1" — parsed to a number where a caller needs Jellyfin's CommunityRating shape. */
  imdbRating: string | null;
  /** This title's own IMDb id (episodes have their own, distinct from the series'). */
  imdbId: string | null;
}

function readCredits(data: {
  Genre?: string;
  Actors?: string;
  Director?: string;
  Writer?: string;
  imdbRating?: string;
  imdbID?: string;
}): OmdbCredits {
  return {
    genres: names(data.Genre),
    actors: names(data.Actors),
    director: names(data.Director),
    writer: names(data.Writer),
    imdbRating: na(data.imdbRating),
    imdbId: na(data.imdbID),
  };
}

export interface OmdbSeries extends OmdbCredits {
  name: string;
  overview: string | null;
  posterUrl: string | null;
  /**
   * OMDb's own Type for this title — "series" for television, "movie" for a
   * film (including one released in parts), null for anything else or absent.
   * The response has always carried this; it was simply never read.
   */
  kind: "series" | "movie" | null;
}

/**
 * The series itself — its own poster, synopsis and credits, not any one
 * episode's. Used for the group's tile on Browse/Search and the collection
 * page header, so "The Curse" reads as a show rather than as whichever
 * episode happened to be picked.
 */
export async function fetchOmdbSeries(imdbId: string): Promise<OmdbSeries | null> {
  const key = process.env.OMDB_API_KEY?.trim();
  if (!key) return null;

  try {
    const url = `${OMDB_ENDPOINT}?i=${encodeURIComponent(imdbId)}&plot=full&apikey=${encodeURIComponent(key)}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000), cache: "no-store" });
    if (!response.ok) {
      recordExternalApiCall("omdb", false);
      return null;
    }

    const data = (await response.json()) as {
      Response?: string;
      Title?: string;
      Plot?: string;
      Poster?: string;
      Genre?: string;
      Actors?: string;
      Director?: string;
      Writer?: string;
      imdbRating?: string;
      imdbID?: string;
      Type?: string;
    };
    if (data.Response === "False" || !data.Title) {
      recordExternalApiCall("omdb", true);
      return null;
    }

    recordExternalApiCall("omdb", true);
    return {
      name: data.Title,
      overview: na(data.Plot),
      posterUrl: na(data.Poster),
      kind: data.Type === "series" ? "series" : data.Type === "movie" ? "movie" : null,
      ...readCredits(data),
    };
  } catch (error) {
    console.warn(`[omdb-episodes] series lookup failed for ${imdbId}:`, error);
    recordExternalApiCall("omdb", false);
    logEvent({
      category: "external_api",
      severity: "warning",
      source: "omdb",
      message: `OMDb series lookup failed for ${imdbId}`,
      detail: { imdbId, error: error instanceof Error ? error.message : String(error) },
      itemId: imdbId,
    });
    return null;
  }
}

export interface OmdbEpisode extends OmdbCredits {
  name: string;
  overview: string | null;
  posterUrl: string | null;
}

/** Null when there's no key configured, OMDb has nothing for this episode, or the request fails. */
export async function fetchOmdbEpisode(
  seriesImdbId: string,
  season: number,
  episode: number,
): Promise<OmdbEpisode | null> {
  const key = process.env.OMDB_API_KEY?.trim();
  if (!key) return null;

  try {
    const url =
      `${OMDB_ENDPOINT}?i=${encodeURIComponent(seriesImdbId)}` +
      `&Season=${season}&Episode=${episode}&plot=full&apikey=${encodeURIComponent(key)}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000), cache: "no-store" });
    if (!response.ok) {
      recordExternalApiCall("omdb", false);
      return null;
    }

    const data = (await response.json()) as {
      Response?: string;
      Title?: string;
      Plot?: string;
      Poster?: string;
      Genre?: string;
      Actors?: string;
      Director?: string;
      Writer?: string;
      imdbRating?: string;
      imdbID?: string;
    };
    if (data.Response === "False" || !data.Title) {
      recordExternalApiCall("omdb", true);
      return null;
    }

    recordExternalApiCall("omdb", true);
    return {
      name: data.Title,
      overview: na(data.Plot),
      posterUrl: na(data.Poster),
      ...readCredits(data),
    };
  } catch (error) {
    console.warn(`[omdb-episodes] lookup failed for ${seriesImdbId} S${season}E${episode}:`, error);
    recordExternalApiCall("omdb", false);
    logEvent({
      category: "external_api",
      severity: "warning",
      source: "omdb",
      message: `OMDb episode lookup failed for ${seriesImdbId} S${season}E${episode}`,
      detail: { seriesImdbId, season, episode, error: error instanceof Error ? error.message : String(error) },
    });
    return null;
  }
}
