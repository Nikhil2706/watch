/**
 * TV-mode detection logic with no server-only dependency — safe to import
 * from a client component (TvProvider.tsx), the Edge middleware, or a
 * server component alike. src/lib/tv/detect.ts wraps the one piece of this
 * that genuinely needs the server (`resolveTvModeFromRequest`, which reads
 * next/headers) around these pure functions.
 */

export const TV_MODE_COOKIE = "watch_tv";

const TV_USER_AGENT_PATTERNS: RegExp[] = [
  /\btizen\b/i, // Samsung
  /\bwebos\b|\bweb0s\b/i, // LG
  /\bgoogletv\b|\bandroidtv\b|\baft[bmnst]\b/i, // Google TV / Android TV / Fire TV
  /\bcrkey\b/i, // Chromecast
  /\bhbbtv\b/i, // European smart-TV standard
  /\bviera\b/i, // Panasonic
  /\bbravia\b/i, // Sony
  /\bnettv\b/i, // Philips
  /\broku\b/i,
  /\bappletv\b/i,
  /smart-tv|smarttv/i,
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
