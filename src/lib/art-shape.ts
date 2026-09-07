/**
 * Which shape a card should be: a film's poster, or an episode's still.
 *
 * Separate from media.ts, which is `server-only` and so cannot be unit tested
 * — same split as http-range.ts. The decision is pure arithmetic over one
 * number Jellyfin already reports, so it belongs somewhere testable.
 *
 * Background: this library has no Episode items. Every TV file was matched
 * individually as a Movie, so an episode's artwork is whatever the scraper
 * found for that file — a 4:3 or 16:9 frame, never a 2:3 poster. Rendering
 * those in poster-shaped cards discarded most of each frame.
 */

/** Just the field the decision needs, so this module stays free of media.ts. */
export interface ArtShapeItem {
  PrimaryImageAspectRatio?: number;
}

/**
 * Above this, artwork is treated as landscape.
 *
 * 1.2 sits in the empty gap between the two clusters that actually exist.
 * Measured across the live library (1,159 items): 438 at ~0.67 (posters), 712
 * at >= 1.33 (stills, mostly 4:3 and 16:9), and 4 anywhere in between. Any
 * threshold in 0.8-1.3 classifies identically; 1.2 leaves room for a squarish
 * poster to stay a poster.
 */
export const WIDE_ART_THRESHOLD = 1.2;

/** Is this item's artwork landscape rather than portrait? */
export function isWideArt(item: ArtShapeItem): boolean {
  const ar = item.PrimaryImageAspectRatio;
  if (typeof ar !== "number" || !Number.isFinite(ar) || ar <= 0) return false;
  return ar >= WIDE_ART_THRESHOLD;
}

/**
 * Should a set of items be laid out as landscape stills?
 *
 * Decided per row rather than per card: a row mixing portrait and landscape
 * tiles reads as broken, so a strict majority wins and the odd item out is
 * fitted into the row's shape instead. An exact tie stays with posters, which
 * is the shape that degrades more gracefully — a still letterboxed into a
 * poster loses nothing, while a poster in a still box is cropped hard.
 */
export function prefersStillLayout(items: readonly ArtShapeItem[]): boolean {
  if (items.length === 0) return false;
  let wide = 0;
  for (const item of items) if (isWideArt(item)) wide += 1;
  return wide * 2 > items.length;
}
