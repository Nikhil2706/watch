/**
 * Holes in a season's episode numbering.
 *
 * Deliberately its own module with ZERO imports, for the reason spelled out at
 * the top of browse-filters.test.ts: media.ts is server-only and holds the
 * SQLite handle, so nothing in it can be imported by a test — which is how the
 * Browse decade filter stayed completely broken without anything noticing.
 * This is small, pure, and easy to get subtly wrong, so it lives out here where
 * a test can reach it.
 */

/**
 * Episode numbers missing from a season, given the ones actually present.
 *
 * Only the holes BETWEEN what is here: [1,2,4,5] reports 4 is preceded by a
 * missing 3. It cannot know that a season stopping at 21 really has 22 —
 * nothing local can, since the only record of a season's true length is the
 * linked IMDb series — so a truncated season reports nothing rather than
 * inventing an ending.
 *
 * Works from the numbers parsed out of the filenames the episode list is
 * already sorted by: no OMDb call, and immune to the numbering drift where a
 * mid-season special shifts OMDb's episode numbers out of step with the S0xE0y
 * names on disk.
 */
export function episodeGaps(episodes: Array<number | null>): number[] {
  const present = episodes.filter((n): n is number => typeof n === "number" && n > 0);
  if (present.length < 2) return [];

  const seen = new Set(present);
  let lowest = present[0]!;
  let highest = present[0]!;
  for (const n of present) {
    if (n < lowest) lowest = n;
    if (n > highest) highest = n;
  }

  const missing: number[] = [];
  for (let n = lowest + 1; n < highest; n += 1) {
    if (!seen.has(n)) missing.push(n);
  }
  return missing;
}
