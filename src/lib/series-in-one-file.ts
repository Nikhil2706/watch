import "server-only";

import { refreshAdminMovie } from "./admin-library-cache";
import { invalidate } from "./cache";
import { setItemImage, setManualMetadata } from "./jellyfin";
import { markMetadataConfirmed } from "./library-curation";
import { fetchSeason, fetchShow, putLink, searchShows } from "./tmdb-store";

/**
 * A TV mini-series kept as one file, shown as a film (tmdb-view.ts
 * filmViewOfShow). Salem's Lot (1979) is two 90-minute parts; the library has
 * them as one 183-minute file. TMDB knows it only as a show and Jellyfin's
 * film search finds nothing right for it (it named it after a "VHS Movie
 * Review"), so Identify can't fix it. This links the file to the show and
 * writes the show's name, summary, year and poster to Jellyfin; the IMDb id is
 * left alone, so ratings keep working.
 */

/** Largest show taken to be a mini-series. Past this it is a series, and a single file is one episode of it. */
export const MAX_MINISERIES_EPISODES = 10;

export class SeriesInOneFileError extends Error {}

export interface ShowChoice {
  tmdbId: number;
  name: string;
  year: number | null;
}

export async function searchMiniseries(query: string): Promise<ShowChoice[]> {
  const q = query.trim();
  if (!q) return [];
  return (await searchShows(q)).slice(0, 12).map((s) => ({ tmdbId: s.id, name: s.name, year: s.year }));
}

interface ShowPayload {
  name?: string;
  overview?: string;
  first_air_date?: string | null;
  number_of_seasons?: number;
  number_of_episodes?: number;
  poster_path?: string | null;
}

/** Fetches the show and its seasons into the store (the film view reads both). */
export async function fetchMiniseries(tmdbId: number): Promise<ShowPayload> {
  const cached = await fetchShow(tmdbId, true);
  const show = cached.payload as ShowPayload;
  for (let n = 1; n <= Math.min(show.number_of_seasons ?? 1, 5); n++) await fetchSeason(tmdbId, n, true);
  return show;
}

export async function identifyAsSeriesInOneFile(input: {
  itemId: string;
  path: string;
  tmdbId: number;
}): Promise<{ name: string; year: number | null; episodes: number | null }> {
  const show = await fetchMiniseries(input.tmdbId);
  const episodes = show.number_of_episodes ?? null;
  if (episodes !== null && episodes > MAX_MINISERIES_EPISODES) {
    throw new SeriesInOneFileError(
      `${show.name ?? "That show"} has ${episodes} episodes: that's a series, not a mini-series in one file. Group its episodes into a show instead.`,
    );
  }
  putLink({
    subjectType: "path",
    subjectId: input.path,
    tmdbKind: "tv",
    tmdbId: input.tmdbId,
    season: null,
    episode: null,
    resolvedBy: "manual",
  });

  const name = show.name?.trim() || "Untitled";
  const year = show.first_air_date ? Number(show.first_air_date.slice(0, 4)) : null;
  await setManualMetadata(input.itemId, { name, overview: show.overview?.trim() || undefined, year: year ?? undefined });
  if (show.poster_path) {
    await setItemImage(input.itemId, `https://image.tmdb.org/t/p/original${show.poster_path}`, "Primary").catch((error) =>
      console.warn("[series-in-one-file] poster not set:", error instanceof Error ? error.message : error),
    );
  }
  markMetadataConfirmed(input.path);
  invalidate("all-movies");
  await refreshAdminMovie(input.itemId).catch(() => undefined);
  return { name, year, episodes };
}
