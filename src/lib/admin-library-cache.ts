import "server-only";

import { getAdminMovie, listAllMoviesAdmin, type AdminMovieListItem } from "./jellyfin";

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
 *  1. A result is reused for FRESH_MS, and past that it is STILL served —
 *     immediately — while a refresh runs behind it. The library only changes
 *     when somebody drops a file in and a scan runs, and the scan route calls
 *     invalidate() itself, so "I just added a film" is never behind. What this
 *     buys is that nobody ever waits 16 seconds for the expensive shape once
 *     it has been fetched once: the console's Library tab opens instantly on
 *     a slightly-old list and corrects itself a moment later. A blocking
 *     fetch happens only when there is nothing cached at all.
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

const FRESH_MS = 60_000;

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
  const existing = inFlight.get(key);

  if (cached) {
    // Stale-while-revalidate: hand back what we have either way, and only
    // kick off a refresh if one isn't already running.
    if (Date.now() - cached.fetchedAt >= FRESH_MS && !existing) {
      void refresh(key, withMediaSources).catch(() => {
        // A failed background refresh keeps the last good listing. The next
        // caller tries again; nobody is shown an error for data they already
        // have.
      });
    }
    return cached.items;
  }

  if (existing) return existing;
  return refresh(key, withMediaSources);
}

function refresh(key: string, withMediaSources: boolean): Promise<AdminMovieListItem[]> {
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
 * Drops both shapes. For changes that alter WHICH films exist — a library
 * scan, a version merge — where there is no single row to patch.
 *
 * Prefer refreshAdminMovie() when one known item changed: this makes the next
 * reader pay for a full re-fetch of the library, which is 16 seconds in the
 * heavy shape.
 */
export function invalidateAdminMovies(): void {
  cache.clear();
}

/**
 * Re-reads ONE item and splices it into whatever is cached.
 *
 * Correcting a film's title or poster changes exactly one row, and dropping
 * the whole listing to reflect that meant the next page load waited on a full
 * re-fetch. This keeps the cache warm and costs a single narrow query.
 *
 * Never throws: a failed refresh leaves the cached row as it was, which is
 * stale by one field, and the ordinary staleness path corrects it within the
 * minute. That is a better outcome than an editing action reporting failure
 * because a follow-up read did.
 */
export async function refreshAdminMovie(itemId: string): Promise<void> {
  for (const [key, entry] of cache) {
    const index = entry.items.findIndex((item) => item.Id === itemId);
    if (index === -1) continue;
    try {
      const fresh = await getAdminMovie(itemId, { withMediaSources: key === "heavy" });
      if (!fresh) {
        // Gone from Jellyfin entirely — drop it rather than keep a ghost.
        entry.items.splice(index, 1);
        continue;
      }
      entry.items[index] = fresh;
    } catch (error) {
      console.warn(`[admin-library-cache] could not refresh ${itemId}:`, error);
    }
  }
}
