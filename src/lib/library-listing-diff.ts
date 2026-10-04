/**
 * Which rows of the library listing have to be fetched again, kept apart from
 * Jellyfin so it can be tested.
 *
 * The full listing with every title's streams (MediaSources) takes Jellyfin
 * ten seconds or more for this library; the same listing without them takes a
 * fifth of a second, and it can carry each title's Etag — a stamp Jellyfin
 * changes whenever it saves the item. So what is already held is checked
 * against the cheap listing's stamps, and only the titles whose stamp moved,
 * or that are new, are asked for in full: 80ms for one.
 */

export interface Stamped {
  Id: string;
  Etag?: string;
}

/**
 * Ids in `listing` that `held` has no current copy of: new titles, titles
 * whose stamp changed, and titles with no stamp at all (nothing to compare,
 * so nothing to trust).
 */
export function staleIds(listing: readonly Stamped[], held: ReadonlyMap<string, { etag: string | undefined }>): string[] {
  const stale: string[] = [];
  for (const row of listing) {
    const copy = held.get(row.Id);
    if (!copy || !row.Etag || copy.etag !== row.Etag) stale.push(row.Id);
  }
  return stale;
}

/** `ids` in runs of at most `size`, for a query that takes a list of ids. */
export function inBatches<T>(ids: readonly T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < ids.length; i += size) batches.push(ids.slice(i, i + size));
  return batches;
}
