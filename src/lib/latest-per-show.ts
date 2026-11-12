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

/**
 * Reads a newest-first listing a page at a time until it holds `cards`
 * distinct cards — a show counts once, however many of its files are new —
 * or the listing ends, or `maxPages` have been read.
 *
 * Home's Recently added folds a show into one card. Reading a fixed number of
 * files first and folding after meant one big show could fill the whole read:
 * Looney Tunes' 466 shorts came in together, and the 200 newest files made a
 * single card. Counting cards while reading puts the show in once and keeps
 * going until the row is full.
 *
 * `fetchPage` returns the raw page (its length says whether the listing has
 * more); `keep` drops what this viewer may not see, so hidden files neither
 * appear nor count. Returns every kept item read, newest first, for the
 * caller to fold.
 */
export async function readUntilCards<T>(
  fetchPage: (startIndex: number, limit: number) => Promise<readonly T[]>,
  options: {
    showOf: (item: T) => string | null | undefined;
    keep: (items: readonly T[]) => readonly T[];
    cards: number;
    pageSize: number;
    maxPages: number;
  },
): Promise<T[]> {
  const kept: T[] = [];
  const seenShows = new Set<string>();
  let count = 0;
  for (let page = 0; page < options.maxPages; page++) {
    const raw = await fetchPage(page * options.pageSize, options.pageSize);
    for (const item of options.keep(raw)) {
      kept.push(item);
      const show = options.showOf(item);
      if (!show) count++;
      else if (!seenShows.has(show)) {
        seenShows.add(show);
        count++;
      }
    }
    if (count >= options.cards || raw.length < options.pageSize) break;
  }
  return kept;
}
