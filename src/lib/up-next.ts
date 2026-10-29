/**
 * When the player offers the next episode.
 *
 * From the start of the credits, and for good once the episode has ended (the
 * screen goes black, and the button is all there is to press). ZERO imports,
 * like episode-gaps.ts, so its test can load it.
 *
 * Where the credits start comes from Jellyfin's Outro media segment when one
 * exists. Nothing in this library has one yet (no chapters, no segment
 * provider installed), so the usual answer is the fallback: the last
 * CREDITS_FALLBACK_SECONDS, which covers a 40-odd-second end crawl like
 * Buffy's without cutting into the last scene of most episodes.
 */

export const CREDITS_FALLBACK_SECONDS = 45;

/** Never offered in the first stretch of anything this short or shorter (a trailer, a clip). */
const MIN_DURATION_SECONDS = 5 * 60;

/** The time, in seconds, from which the next episode is offered; null for never. */
export function upNextFrom(duration: number, creditsStart: number | null | undefined): number | null {
  if (!Number.isFinite(duration) || duration < MIN_DURATION_SECONDS) return null;
  if (typeof creditsStart === "number" && creditsStart > 0 && creditsStart < duration) return creditsStart;
  return duration - CREDITS_FALLBACK_SECONDS;
}

export interface UpNextState {
  currentTime: number;
  duration: number;
  creditsStart?: number | null;
  ended: boolean;
  /** The viewer stepped away from it during the credits; it returns when the episode ends. */
  dismissed: boolean;
}

export function showUpNext(s: UpNextState): boolean {
  if (s.ended) return true;
  if (s.dismissed) return false;
  const from = upNextFrom(s.duration, s.creditsStart);
  return from !== null && s.currentTime >= from;
}
