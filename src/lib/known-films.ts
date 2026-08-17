import "server-only";

import { listAllMoviesAdmin } from "./jellyfin";

/**
 * Shared by every backfill scheduler (OMDb ratings, Wikipedia) that needs
 * "every library movie with a known IMDb id" — one cached admin-scoped
 * Jellyfin pull instead of each scheduler keeping its own, since
 * listAllMoviesAdmin() also pulls MediaSources for the whole library, which
 * is genuinely heavy (see its own comment in jellyfin.ts).
 */

export interface KnownFilm {
  imdbId: string;
  jellyfinId: string;
  name: string;
  year: number | null;
}

/** New titles arrive far slower than this refreshes, so a long TTL is fine. */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * How often instrumentation.ts's proactive refresh loop re-fetches this
 * cache — deliberately shorter than CACHE_TTL_MS so the cache is never more
 * than this old by the time any backfill tick (every 10 minutes) reads it.
 * Without this, the ~90-second admin pull below would otherwise land
 * synchronously inside whichever tick's turn it was when the 6h TTL expired,
 * in the same process serving real requests.
 */
export const REFRESH_INTERVAL_MS = 5.5 * 60 * 60 * 1000;

interface FilmListCache {
  films: KnownFilm[];
  fetchedAt: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __jellyfinGateKnownFilms: FilmListCache | undefined;
}

async function fetchAndCacheKnownFilms(): Promise<KnownFilm[]> {
  const movies = await listAllMoviesAdmin();
  const films = movies
    .filter((m): m is typeof m & { ProviderIds: { Imdb: string } } => Boolean(m.ProviderIds?.Imdb))
    .map((m) => ({ imdbId: m.ProviderIds.Imdb, jellyfinId: m.Id, name: m.Name, year: m.ProductionYear ?? null }));
  globalThis.__jellyfinGateKnownFilms = { films, fetchedAt: Date.now() };
  return films;
}

export async function getKnownFilms(): Promise<KnownFilm[]> {
  const cache = globalThis.__jellyfinGateKnownFilms;
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.films;
  }
  return fetchAndCacheKnownFilms();
}

/** Unconditional refresh, called only by instrumentation.ts's own schedule. */
export async function refreshKnownFilmsNow(): Promise<void> {
  await fetchAndCacheKnownFilms();
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
