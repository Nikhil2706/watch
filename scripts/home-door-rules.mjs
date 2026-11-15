/**
 * The home door's rules, kept apart from the server (home-door.mjs) so they
 * can be tested without opening a socket.
 *
 * The home door lets a device on the same network as this Mac reach the site
 * directly, over plain http on the LAN, instead of out to Cloudflare and back.
 * On 2026-11-16 the owner's Airtel line reached Cloudflare in Paris rather
 * than India: every request took 1-13 s and a TV in the same flat could not
 * start an episode, while the gate answered locally in 0.02 s.
 */

/** What the door answers at its own address, so the app knows it found this site's door and not some other device. */
export const HELLO_PATH = "/__watch-home";

/**
 * The site's cookies are marked Secure in production, and a browser drops a
 * Secure cookie that arrives over plain http, so nobody could sign in through
 * the door. On the way back the attribute is taken off. Everything else about
 * the cookie (HttpOnly, SameSite, Path, Max-Age) is kept. The cookie then
 * belongs to the door's own address, a separate jar from the public site's.
 */
export function relaxCookie(setCookie) {
  return String(setCookie)
    .split(";")
    .filter((part) => part.trim().toLowerCase() !== "secure")
    .join(";");
}

/**
 * A redirect to the public address would send a home device straight back out
 * to Cloudflare. One that points at the site's public origin is turned into
 * the same path on the door's origin; anything else (a relative path, another
 * site) is left alone.
 */
export function homeLocation(location, publicUrl, doorOrigin) {
  if (!location) return location;
  const pub = String(publicUrl).replace(/\/+$/, "");
  if (location === pub) return doorOrigin + "/";
  if (location.startsWith(pub + "/") || location.startsWith(pub + "?") || location.startsWith(pub + "#")) {
    return doorOrigin + location.slice(pub.length);
  }
  return location;
}

/**
 * Only addresses a home network uses: the door is for devices in the same
 * flat. A Host header naming anything else (a public name pointed here, a
 * DNS-rebinding page) is refused, so a web page elsewhere cannot use a
 * visitor's browser to reach the site through the door.
 */
export function isHomeHost(hostHeader) {
  if (!hostHeader) return false;
  const host = String(hostHeader)
    .trim()
    .toLowerCase()
    .replace(/:\d+$/, "");
  if (host === "localhost" || host.endsWith(".local")) return true;
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if ([m[1], m[2], m[3], m[4]].some((n) => Number(n) > 255)) return false;
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}
