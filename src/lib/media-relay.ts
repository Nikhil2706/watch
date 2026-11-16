/**
 * Where the video player loads video from.
 *
 * Normally the site's own /jf/... address. Inside the Android app, at home on
 * the Mac's network, the app runs a small relay on the device itself and
 * says so by setting `window.__watchMediaBase` (HomeDoor/MediaRelay in
 * apps/mobile), e.g. "http://127.0.0.1:41234/3f9c...": the relay adds the
 * sign-in and fetches the video from the Mac directly, not via Cloudflare.
 *
 * Why the player needs a real server for this: on 2026-11-16 a TV's WebView
 * would not play video that the app handed it from its request handler,
 * whole or in pieces, though pages and pictures were fine that way. The
 * relay is an ordinary HTTP server, so seeking (Range requests) works the
 * standard way. 127.0.0.1 counts as a secure origin, so an https page may
 * load from it.
 *
 * ZERO imports, so it can be tested.
 */

/** The relay's base, if the app set a valid one: plain http on 127.0.0.1 only. */
export function mediaBase(w: { __watchMediaBase?: unknown } | undefined): string | null {
  const base = w?.__watchMediaBase;
  if (typeof base !== "string") return null;
  return /^http:\/\/127\.0\.0\.1:\d{2,5}\/[A-Za-z0-9_-]{16,}$/.test(base) ? base : null;
}

/** `src` through the relay when there is one; only the site's own /jf/ addresses are moved. */
export function viaMediaRelay(src: string, base: string | null): string {
  if (!base || !src.startsWith("/jf/")) return src;
  return base + src;
}

/** For the browser: the relay base on this page, read once. */
export function currentMediaBase(): string | null {
  return typeof window === "undefined" ? null : mediaBase(window as { __watchMediaBase?: unknown });
}
