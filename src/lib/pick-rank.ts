/**
 * The small pure rules of a pick, kept apart from the database so they can be
 * tested: what number a title shows, in what order titles run, and how a
 * writeup is cut into paragraphs or flattened for a tile.
 */

/** Home shows a pick this long after its first publish, unless pinned. */
export const HOME_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The number under a poster in a ranked pick.
 *
 * A pick converted from a list keeps the list's own rank, so the row skips the
 * films the library does not have (2, 7, 11…). A pick built by hand has no
 * stored rank and numbers by position.
 */
export function displayRank(storedRank: number | null, index: number): number {
  return storedRank ?? index + 1;
}

/**
 * Titles in the order a ranked pick shows them: by the number each will carry,
 * 1 first. Position breaks ties, and is the whole order of an unranked pick.
 */
export function orderForDisplay<T extends { rank: number | null; position: number }>(
  items: readonly T[],
  ranked: boolean,
): T[] {
  const byPosition = [...items].sort((a, b) => a.position - b.position);
  if (!ranked) return byPosition;
  return byPosition
    .map((item, index) => ({ item, n: displayRank(item.rank, index) }))
    .sort((a, b) => a.n - b.n || a.item.position - b.item.position)
    .map((x) => x.item);
}

/** A writeup's paragraphs — blank lines separate them, as typed in the console. */
export function writeupParagraphs(writeup: string | null | undefined): string[] {
  if (!writeup) return [];
  return writeup
    .split(/\n{2,}/)
    .map((p) => p.replace(/[ \t]*\n[ \t]*/g, " ").trim())
    .filter(Boolean);
}

/**
 * A writeup as one run of plain text, for the lines under a poster. The
 * formatting tags a writeup may carry (rich-text.ts) are dropped: a tile
 * clamps to a few lines and has no use for them.
 */
export function writeupPlainText(writeup: string | null | undefined): string {
  return writeupParagraphs(writeup)
    .join(" ")
    .replace(/<\/?[a-zA-Z0-9]+[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Whether a live pick belongs on Home right now. */
export function showsOnHome(
  pick: { pinned: boolean; publishedAt: number | null },
  now: number = Date.now(),
): boolean {
  if (pick.pinned) return true;
  return pick.publishedAt !== null && now - pick.publishedAt < HOME_WINDOW_MS;
}
