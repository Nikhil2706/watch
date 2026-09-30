/**
 * One cookie's value from a raw Cookie header, or null.
 *
 * Split, not a regex: the screening proxy built its pattern in a template
 * string, where `\s` silently becomes a plain "s", so it only found the cookie
 * when it came FIRST in the header. A recipient whose browser sent any other
 * cookie for the site first got 401 on every stream request, while the
 * screening page itself (which reads cookies properly) looked fine.
 */
export function readCookie(header: string | null | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return null;
}
