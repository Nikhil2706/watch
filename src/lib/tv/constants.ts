/**
 * TV-mode detection logic with no server-only dependency — safe to import
 * from a client component (TvProvider.tsx), the Edge middleware, or a
 * server component alike. src/lib/tv/detect.ts wraps the one piece of this
 * that genuinely needs the server (`resolveTvModeFromRequest`, which reads
 * next/headers) around these pure functions.
 */

export const TV_MODE_COOKIE = "watch_tv";

/**
 * Fire TV, matched on Amazon's device model code.
 *
 * This used to be `/\baft[bmnst]\b/i`, which only matched a four-character
 * token — AFTB, AFTM, AFTN, AFTS, AFTT — and so matched almost no real device.
 * Amazon's actual codes are longer and keep growing: AFTKA (Stick 4K Max),
 * AFTMM (Stick 4K), AFTSSS (Stick Lite), AFTKMST12, AFTBAMR311. Every one of
 * those failed the old trailing \b, so a Fire TV got the phone layout.
 *
 * THE MISSING /i IS DELIBERATE — it is the only thing separating a device code
 * from the English word "after". Amazon writes these codes uppercase in the
 * agent ("; AFTKA Build/PS7233"), while prose does not, so requiring uppercase
 * lets the suffix stay open-ended without matching "after", "aftermath" or
 * "afternoon". Adding /i here silently turns TV mode on for a lot of ordinary
 * browsers; tv-user-agent.test.ts fails if anyone does.
 *
 * The leading \b keeps it out of the middle of longer words such as DRAFT.
 */
const FIRE_TV_MODEL = /\bAFT[A-Z0-9]{1,10}\b/;

const TV_USER_AGENT_PATTERNS: RegExp[] = [
  /\btizen\b/i, // Samsung
  /\bwebos\b|\bweb0s\b/i, // LG
  /\bgoogletv\b|\bandroidtv\b/i, // Google TV / Android TV
  /\bcrkey\b/i, // Chromecast
  /\bhbbtv\b/i, // European smart-TV standard
  /\bviera\b/i, // Panasonic
  /\bbravia\b/i, // Sony
  /\bnettv\b/i, // Philips
  /\broku\b/i,
  /\bappletv\b/i,
  /smart-tv|smarttv/i,
  FIRE_TV_MODEL,
];

export function isTvUserAgent(userAgent: string | null): boolean {
  if (!userAgent) return false;
  return TV_USER_AGENT_PATTERNS.some((pattern) => pattern.test(userAgent));
}

/** Reads the persisted override cookie. `null` means "no opinion yet". */
export function tvModeFromCookie(cookieValue: string | undefined): boolean | null {
  if (cookieValue === "1") return true;
  if (cookieValue === "0") return false;
  return null;
}

export function resolveTvMode(input: {
  cookieValue: string | undefined;
  userAgent: string | null;
}): boolean {
  const fromCookie = tvModeFromCookie(input.cookieValue);
  if (fromCookie !== null) return fromCookie;
  return isTvUserAgent(input.userAgent);
}
