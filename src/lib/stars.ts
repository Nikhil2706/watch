/**
 * Star rating conversion — deliberately NOT server-only, since both a
 * server component (RatingsRow) and a client component (CommunityClient)
 * need this.
 *
 * The database and API still speak whole numbers 1-10 (user_ratings.score,
 * unchanged) — that's just the half-star scale in disguise: score 1 = half
 * a star, score 10 = five stars, one integer per half-star step. Nothing
 * about storage or validation changed; only the display and input layers
 * convert to/from stars, right at the boundary.
 */

export type StarState = "full" | "half" | "empty";

/** A single 24x24 star outline, shared by every place a star renders. */
export const STAR_PATH =
  "M12 2.6l2.9 6.5 6.9.7-5.2 4.8 1.5 7-6.1-3.7-6.1 3.7 1.5-7-5.2-4.8 6.9-.7z";

/** DB score (1-10) -> stars (0.5-5.0). */
export function scoreToStars(score: number): number {
  return score / 2;
}

/** Stars (0.5-5.0) -> DB score (1-10), rounded to the nearest half-star. */
export function starsToScore(stars: number): number {
  return Math.round(stars * 2);
}

/** Five slot states (full/half/empty) for a given star value — used by both the static display and the interactive picker's fill. */
export function starStates(value: number | null): StarState[] {
  const rounded = value === null ? 0 : Math.round(value * 2) / 2;
  return Array.from({ length: 5 }, (_, i) => {
    const pos = i + 1;
    if (rounded >= pos) return "full";
    if (rounded >= pos - 0.5) return "half";
    return "empty";
  });
}
