import "server-only";

import { listAllMoviesAdmin, type AdminMovieListItem } from "./jellyfin";

/**
 * A short-lived cache of the whole-library admin listing.
 *
 * Every admin surface that searches or lists the library starts by pulling all
 * of it from Jellyfin. That call is not cheap even in its light shape, and the
 * search boxes fire it on a 250ms debounce — so typing "west wing" used to mean
 * several full library fetches for one lookup, each returning a handful of
 * names.
 *
 * Two things happen here:
 *
 *  1. A result is reused for TTL_MS. The library only changes when somebody
 *     drops a file in and a scan runs, so seconds-old data is not stale in any
 *     way a curator would notice — and the scan route calls invalidate()
 *     anyway, so "I just added a film" is still immediate.
 *
 *  2. Concurrent callers share ONE in-flight request. Without this the very
 *     first keystroke of a search still fans out into several simultaneous
 *     full-library fetches, which is the worst case rather than the best.
 *
 * The two shapes are cached separately: the heavy one carries MediaSources
 * (needed only to answer "does this file have subtitles"), the light one does
 * not, and a caller that needs the heavy shape must not be handed the light
 * one just because it arrived first.
 */

const TTL_MS = 60_000;

interface Entry {
  fetchedAt: number;
  items: AdminMovieListItem[];
}

const cache = new Map<string, Entry>();
const inFlight = new Map<string, Promise<AdminMovieListItem[]>>();

function keyFor(withMediaSources: boolean): string {
  return withMediaSources ? "heavy" : "light";
}

export async function getAdminMovies(
  options: { withMediaSources?: boolean } = {},
): Promise<AdminMovieListItem[]> {
  const { withMediaSources = true } = options;
  const key = keyFor(withMediaSources);

  const cached = cache.get(key);
  if (cached && Date.now() - cached.fetchedAt < TTL_MS) return cached.items;

  const existing = inFlight.get(key);
  if (existing) return existing;

  const request = listAllMoviesAdmin({ withMediaSources })
    .then((items) => {
      cache.set(key, { fetchedAt: Date.now(), items });
      return items;
    })
    .finally(() => {
      // Always clear, success or failure: a failed fetch must not wedge every
      // later caller onto the same rejected promise.
      inFlight.delete(key);
    });

  inFlight.set(key, request);
  return request;
}

/**
 * Drops both shapes. Called after anything that changes what Jellyfin would
 * return — a library scan, an applied metadata match — so the next read is
 * fresh rather than up to a minute behind the thing the curator just did.
 */
export function invalidateAdminMovies(): void {
  cache.clear();
}
