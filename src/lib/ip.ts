import "server-only";

import { env } from "./env";

/**
 * Best-effort client IP, used only as a rate-limit bucket key and for session
 * audit rows. Never used for authorisation.
 *
 * Header order matters and is security-relevant:
 *
 *  - `CF-Connecting-IP` is only consulted when TRUST_CF_CONNECTING_IP is on.
 *    It is a plain request header. If this app is reachable by any path that
 *    does not pass through Cloudflare, a client can set it to a random value on
 *    every request and get a fresh rate-limit bucket each time, which silently
 *    turns the login limiter off. Only enable it once the origin genuinely
 *    cannot be reached directly.
 *
 *  - Node/Next route handlers do not expose the underlying socket address, so
 *    the "socket address" fallback in practice means whatever `next start` was
 *    given by the thing in front of it (`X-Forwarded-For` / `X-Real-IP`).
 *
 * When nothing is available, every such request shares the `unknown` bucket.
 * That fails closed: unattributable traffic is collectively limited rather than
 * exempt.
 */
export function getClientIp(request: Request): string {
  const headers = request.headers;

  if (env.trustCloudflareIp) {
    const cf = headers.get("cf-connecting-ip");
    if (cf) return normalise(cf);
  }

  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    // Left-most entry is the original client; the rest are proxy hops.
    const first = forwarded.split(",")[0];
    if (first && first.trim()) return normalise(first);
  }

  const real = headers.get("x-real-ip");
  if (real) return normalise(real);

  return "unknown";
}

function normalise(value: string): string {
  const trimmed = value.trim();
  // IPv4-mapped IPv6 (::ffff:1.2.3.4) and bare IPv4 should share one bucket.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(trimmed);
  const result = mapped?.[1] ?? trimmed;
  // Bound the key length so a hostile header cannot bloat the limiter map.
  return result.slice(0, 64);
}

/** User agent for the session audit row, truncated to something sane. */
export function getUserAgent(request: Request): string | null {
  const ua = request.headers.get("user-agent");
  return ua ? ua.slice(0, 256) : null;
}
