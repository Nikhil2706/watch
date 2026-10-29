/**
 * One entry per show in a newest-first list of things watched.
 *
 * Working through a series puts every episode into Recently watched, so a
 * week of Buffy pushed everything else off the row. Keeping only each show's
 * newest entry leaves one card per show, on the episode last watched.
 *
 * ZERO imports, like episode-gaps.ts, so its test can load it; the caller says
 * which show an item belongs to.
 */

/**
 * `items` newest first; returns them in the same order with every entry after
 * a show's first dropped. Anything `showOf` gives no show (a film) is kept.
 */
export function latestPerShow<T>(
  items: readonly T[],
  showOf: (item: T) => string | null | undefined,
  limit: number = Number.POSITIVE_INFINITY,
): T[] {
  const seen = new Set<string>();
  const kept: T[] = [];
  for (const item of items) {
    if (kept.length >= limit) break;
    const show = showOf(item);
    if (show) {
      if (seen.has(show)) continue;
      seen.add(show);
    }
    kept.push(item);
  }
  return kept;
}
