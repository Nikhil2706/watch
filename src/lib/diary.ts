/**
 * A friend's diary, Letterboxd-style: each time they finished something,
 * newest first, with whether it was a rewatch and what they made of it (their
 * stars and their latest review). Pure, so it is tested directly;
 * friends-diary.ts reads watch_log, user_ratings and film_comments.
 */

export interface LogRow {
  itemId: string;
  imdbId: string | null;
  watchedAt: number;
}

export interface DiaryEntry {
  itemId: string;
  imdbId: string | null;
  watchedAt: number;
  /** They had finished it before this time. */
  rewatch: boolean;
  /** 1-10 (half stars), their rating of the film or show, if any. */
  score: number | null;
  /** Their latest review of it, if any. */
  review: string | null;
}

/**
 * `ratings` and `reviews` are keyed by IMDb id (a show's by its series id,
 * looked up by the caller through `imdbOf`). A rewatch is any finish after
 * an earlier one of the same item.
 */
export function diaryEntries(
  log: readonly LogRow[],
  ratings: ReadonlyMap<string, number>,
  reviews: ReadonlyMap<string, string>,
  imdbOf: (row: LogRow) => string | null = (row) => row.imdbId,
): DiaryEntry[] {
  const oldestFirst = [...log].sort((a, b) => a.watchedAt - b.watchedAt);
  const seen = new Set<string>();
  const entries = oldestFirst.map((row) => {
    const rewatch = seen.has(row.itemId);
    seen.add(row.itemId);
    const imdb = imdbOf(row);
    return {
      itemId: row.itemId,
      imdbId: row.imdbId,
      watchedAt: row.watchedAt,
      rewatch,
      score: imdb ? (ratings.get(imdb) ?? null) : null,
      review: imdb ? (reviews.get(imdb) ?? null) : null,
    };
  });
  return entries.reverse();
}
