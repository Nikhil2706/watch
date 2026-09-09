/**
 * "More like this", once TMDB has had its say.
 *
 * The design here is set by a measurement rather than a preference, and the
 * measurement was a surprise. TMDB offers about 20 recommendations and 17
 * similar titles per film, with 100% coverage — but intersected with the 390
 * films actually owned here:
 *
 *   recommendations   median 0, mean 0.6, p90 2, max 5
 *   similar           median 0, mean 0.2, p90 1, max 4
 *   both combined     median 0, mean 0.7, p90 2, max 6
 *
 * and 230 of 401 films (57%) get nothing at all. So TMDB cannot be the row: it
 * would be empty more often than not. The plan's idea of "blend the two
 * sources" was written before that was known and does not survive it.
 *
 * What TMDB is good for here is ENDORSEMENT. Jellyfin's own /Similar already
 * fills the row from the library, ranked by shared genres and people; TMDB
 * knowing about a pairing is independent evidence that the pairing is real.
 * So a title both sources agree on is moved to the front and labelled, the
 * rest keep Jellyfin's order, and the occasional owned recommendation Jellyfin
 * missed is appended rather than dropped.
 *
 * The row therefore never gets shorter, never gets emptier, and on the 43% of
 * films where TMDB has something to say, says it.
 *
 * Pure and importless so the ranking can be tested on its own.
 */

export interface RankableItem {
  Id: string;
  /** Absent for anything Jellyfin has no IMDb id for; such items simply cannot be endorsed. */
  imdbId?: string | null;
}

export interface RankedSimilar<T> {
  items: T[];
  /** Item ids TMDB independently recommends. The UI badges these. */
  endorsed: Set<string>;
  /** How many came from TMDB alone — nothing in Jellyfin's list matched them. */
  addedByTmdb: number;
}

/**
 * Order Jellyfin's list by TMDB agreement, then append what only TMDB found.
 *
 * `extras` are already-resolved library items, so appending one can never
 * produce a tile that does not play — every row on this page is owned-only,
 * which is not an accident: Jellyfin's /Similar cannot return anything else,
 * and SeriesRow filters a Wikipedia franchise list down to owned for the same
 * reason. A poster you cannot press play on is a dead end.
 */
export function rankSimilar<T extends RankableItem>(
  jellyfinItems: readonly T[],
  endorsedImdbIds: ReadonlySet<string>,
  extras: readonly T[] = [],
  limit = 12,
): RankedSimilar<T> {
  const endorsed = new Set<string>();

  const agreed: T[] = [];
  const rest: T[] = [];
  for (const item of jellyfinItems) {
    if (item.imdbId && endorsedImdbIds.has(item.imdbId)) {
      endorsed.add(item.Id);
      agreed.push(item);
    } else {
      rest.push(item);
    }
  }

  // Stable within each half: Jellyfin's own ranking already carries the
  // director-diversity discount applied in getSimilar(), and re-sorting the
  // whole list would throw that away to express one bit of information.
  const seen = new Set(jellyfinItems.map((i) => i.Id));
  const appended: T[] = [];
  for (const extra of extras) {
    if (seen.has(extra.Id)) continue;
    seen.add(extra.Id);
    endorsed.add(extra.Id);
    appended.push(extra);
  }

  const items = [...agreed, ...rest, ...appended].slice(0, limit);
  // Only count what actually survived the limit — reporting an addition the
  // viewer cannot see would make the number a lie.
  const surviving = new Set(items.map((i) => i.Id));
  return {
    items,
    endorsed: new Set([...endorsed].filter((id) => surviving.has(id))),
    addedByTmdb: appended.filter((i) => surviving.has(i.Id)).length,
  };
}
