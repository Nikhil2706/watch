/**
 * Keeping a TV's web engine inside its memory.
 *
 * The Mi TV in use since 2026-11-01 has 1.8 GB, about 450 MB of it free. Its
 * web engine was measured growing by about 7 MB a minute through a transcoded
 * (HLS) episode of Angel, while a directly played file stayed flat at 175 MB:
 * hls.js keeps every second already watched (backBufferLength defaults to
 * Infinity). After about 50 minutes the next title opened crashed the engine,
 * and with it the app.
 *
 * So on a TV the watched part is kept to a memory budget rather than a fixed
 * time: the same 100 MB is fourteen minutes of a standard-definition
 * transcode and under two of a 1080p one. Phones and computers keep hls.js's
 * own behaviour.
 *
 * Pure, so it is tested directly.
 */

/** How much already-watched video a TV keeps, in bytes. */
export const TV_BACK_BUFFER_BYTES = 100 * 1024 * 1024;

/** Never less than this: a short jump back stays instant. */
export const MIN_BACK_BUFFER_SECONDS = 60;

/** Never more than this, whatever the bitrate. */
export const MAX_BACK_BUFFER_SECONDS = 15 * 60;

/** Before the stream's bitrate is known. */
export const DEFAULT_TV_BACK_BUFFER_SECONDS = MIN_BACK_BUFFER_SECONDS;

/** Seconds of watched video that fit the budget at this bitrate (bits per second). */
export function tvBackBufferSeconds(bitrate: number | null | undefined): number {
  if (!bitrate || !Number.isFinite(bitrate) || bitrate <= 0) return DEFAULT_TV_BACK_BUFFER_SECONDS;
  const seconds = Math.floor((TV_BACK_BUFFER_BYTES * 8) / bitrate);
  return Math.min(MAX_BACK_BUFFER_SECONDS, Math.max(MIN_BACK_BUFFER_SECONDS, seconds));
}

/**
 * Whether this page arrived by an in-app navigation rather than a page load.
 *
 * The web engine's memory from the pages and players before it is released
 * properly only when a new document loads. A TV opening a title from a page it
 * navigated to in-app reloads it, once: after the reload the URLs match.
 */
export function cameByInAppNavigation(documentUrl: string | null | undefined, currentUrl: string): boolean {
  if (!documentUrl) return false;
  try {
    const first = new URL(documentUrl);
    const now = new URL(currentUrl);
    return first.pathname !== now.pathname || first.search !== now.search;
  } catch {
    return false;
  }
}
