import "server-only";

import { getAdminMovie, getAdminMoviesByIds, listAllMoviesAdmin, type AdminMovieListItem } from "./jellyfin";
import { inBatches, staleIds } from "./library-listing-diff";

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

/**
 * Bumped whenever something invalidates the listing.
 *
 * A fetch that was already in flight when the invalidation happened read
 * Jellyfin BEFORE the write, so its result is pre-write data — and without
 * this it would land in the cache a moment later and be served as current for
 * the next minute. Dropping the cache is not enough on its own; the answer
 * already on the wire has to be refused too.
 */
let generation = 0;

function keyFor(withMediaSources: boolean): string {
  return withMediaSources ? "heavy" : "light";
}

/*
 * The heavy shape, title by title, kept across invalidations.
 *
 * Dropping the listing used to mean the next reader waited for all of it
 * again: ten to sixteen seconds, after every re-identification, every version
 * merge, every special-feature change and every scan — which is what made the
 * console's Library tab feel slow to work in, one edit at a time. Almost none
 * of what came back had changed.
 *
 * So each title's heavy row is held here with the Etag it was read at. A
 * refresh reads the cheap listing (a fifth of a second, Etags included),
 * fetches in full only the titles whose stamp moved or that are new, and
 * reuses the rest. Invalidating the listing no longer empties this; it only
 * means "check the stamps again".
 *
 * Two safety nets, because an Etag is Jellyfin's word that nothing changed:
 * everything is fetched whole again every FULL_EVERY_MS, behind the scenes so
 * nobody waits for it, and a title that has just been re-identified is
 * dropped from here outright (forgetAdminMovie) rather than trusted.
 */
const held = new Map<string, { etag: string | undefined; item: AdminMovieListItem }>();
let heldWholeAt = 0;
let wholeInBackground = false;
const FULL_EVERY_MS = 30 * 60 * 1000;
/** Past this many changed titles, one whole fetch is quicker than the pieces. */
const MAX_PIECEMEAL = 300;
const BATCH_SIZE = 50;

async function fetchWholeHeavy(): Promise<AdminMovieListItem[]> {
  const items = await listAllMoviesAdmin({ withMediaSources: true });
  held.clear();
  for (const item of items) held.set(item.Id, { etag: item.Etag, item });
  heldWholeAt = Date.now();
  return items;
}

async function fetchHeavy(): Promise<AdminMovieListItem[]> {
  if (held.size === 0) return fetchWholeHeavy();

  const listing = await listAllMoviesAdmin({ withMediaSources: false });
  const stale = staleIds(listing, held);
  if (stale.length > MAX_PIECEMEAL) return fetchWholeHeavy();

  for (const batch of inBatches(stale, BATCH_SIZE)) {
    for (const item of await getAdminMoviesByIds(batch)) held.set(item.Id, { etag: item.Etag, item });
  }
  const present = new Set(listing.map((row) => row.Id));
  for (const id of [...held.keys()]) if (!present.has(id)) held.delete(id);

  if (Date.now() - heldWholeAt > FULL_EVERY_MS && !wholeInBackground) {
    wholeInBackground = true;
    void fetchWholeHeavy()
      .catch(() => {
        // The pieces already answered this reader; the next refresh tries the
        // whole fetch again.
      })
      .finally(() => {
        wholeInBackground = false;
      });
  }

  // In the listing's order. A title Jellyfin listed but did not return in
  // full keeps its cheap row rather than going missing.
  return listing.map((row) => held.get(row.Id)?.item ?? row);
}

/**
 * After a re-identification, how long every read checks Jellyfin again
 * instead of trusting the cache. Jellyfin applies a match in its own time;
 * a listing read in that gap holds the old row, and caching it for the usual
 * minute is what once re-linked three films to the ones they had just been
 * corrected from (see forgetAdminMovie). Checking again is cheap now, so for
 * this long nothing is cached at all.
 */
const SETTLE_MS = 90_000;
let unsettledUntil = 0;

export async function getAdminMovies(
  options: { withMediaSources?: boolean } = {},
): Promise<AdminMovieListItem[]> {
  const { withMediaSources = true } = options;
  const key = keyFor(withMediaSources);

  const cached = cache.get(key);
  const existing = inFlight.get(key);

  if (cached && Date.now() >= unsettledUntil) {
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
  const startedAt = generation;
  const request = (withMediaSources ? fetchHeavy() : listAllMoviesAdmin({ withMediaSources: false }))
    .then((items) => {
      // Something was invalidated while this was in flight, so these items
      // predate that change. Hand them to the caller that is already waiting —
      // they are no worse than what it would have got — but do not store them,
      // or the next minute of readers gets pre-write data presented as fresh.
      if (generation === startedAt) cache.set(key, { fetchedAt: Date.now(), items });
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
 * The next reader waits for the cheap listing and for whichever titles
 * changed (see `held` above) — well under a second in the ordinary case, where
 * it used to be the whole heavy listing again.
 */
export function invalidateAdminMovies(): void {
  cache.clear();
  generation += 1;
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
/**
 * Forget one item, so the next read fetches it rather than trusting a copy.
 *
 * refreshAdminMovie() above re-reads immediately, which is right for a title
 * or a poster the caller just wrote. It is WRONG after a re-identification:
 * Jellyfin applies a remote match asynchronously, so an immediate re-read
 * returns the pre-refresh row and then caches it as though it were the new
 * truth. That is not theoretical — it made the TMDB backfill re-link
 * [Rec] 2 to The Descent: Part 2 three times in a row, because
 * runTmdbBackfillTick() reads this listing for ProviderIds, and only a process
 * restart cleared it.
 *
 * Dropping the cached listing instead costs one re-fetch on the next read, by
 * which point Jellyfin has settled.
 *
 * It drops the whole listing rather than splicing the row out of it, which the
 * first version of this did. Splicing and setting fetchedAt = 0 does not make
 * the next caller wait: getAdminMovies() is stale-while-revalidate, so it still
 * hands back the cached array — now SHORT BY THE FILM THAT JUST CHANGED — and
 * merely starts a refresh behind it. On 2026-09-11 that is precisely what
 * happened: a backfill pass straight after three re-identifications did not see
 * the three films at all, and the refresh it kicked off read Jellyfin before
 * the match had settled and cached the OLD provider ids as current, so the next
 * pass re-linked all three to the films they had just been corrected from.
 * Only restarting the process cleared it.
 *
 * "By which point Jellyfin has settled" leaned on the re-fetch itself taking
 * ten seconds and more. It no longer does, so the settling is made explicit:
 * for SETTLE_MS after this, every read goes to Jellyfin and nothing it reads
 * is trusted for longer than that one read.
 */
export function forgetAdminMovie(itemId: string): void {
  for (const [key, entry] of cache) {
    // Only the shapes that actually hold a copy.
    if (entry.items.some((item) => item.Id === itemId)) cache.delete(key);
  }
  // Its heavy row is read again whatever its stamp says.
  held.delete(itemId);
  unsettledUntil = Date.now() + SETTLE_MS;
  // Unconditional, even when nothing was cached: a fetch may be in flight that
  // started before the write, and it must not be allowed to cache its answer.
  generation += 1;
}

export async function refreshAdminMovie(itemId: string): Promise<void> {
  for (const [key, entry] of cache) {
    const index = entry.items.findIndex((item) => item.Id === itemId);
    if (index === -1) continue;
    try {
      const fresh = await getAdminMovie(itemId, { withMediaSources: key === "heavy" });
      if (!fresh) {
        // Gone from Jellyfin entirely — drop it rather than keep a ghost.
        entry.items.splice(index, 1);
        if (key === "heavy") held.delete(itemId);
        continue;
      }
      entry.items[index] = fresh;
      // Held without a stamp, so the next refresh reads it once more: this
      // copy is from the moment of the edit, and Jellyfin may save again.
      if (key === "heavy") held.set(itemId, { etag: undefined, item: fresh });
    } catch (error) {
      console.warn(`[admin-library-cache] could not refresh ${itemId}:`, error);
    }
  }
}
