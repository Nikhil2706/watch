import { env } from "@/lib/env";
import { getSessionFromRequest, sessionCookie, touchSession } from "@/lib/session";
import { stripCredentials } from "@/lib/strip-credentials";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Without this Next would try to buffer the response to compute a cache entry,
// which for a 6 GB remux is exactly the failure mode this proxy must avoid.
export const fetchCache = "force-no-store";

/**
 * Authenticated reverse proxy to Jellyfin.
 *
 * Every request here is rewritten to carry the Jellyfin access token belonging
 * to the caller's session, attached server-side. The browser never sees that
 * token: it only ever sends the opaque session cookie. That is the whole point
 * of this app — if the token reached client-side JavaScript, a user could talk
 * to Jellyfin directly and this gateway's deny-list, rate limits and revocation
 * would all be optional.
 *
 * This path carries video. Two rules follow from that and neither is negotiable:
 * the body is piped, never buffered, and Range semantics are passed through
 * untouched in both directions.
 */

/* ------------------------------------------------------------------ *
 * Endpoint deny-list
 * ------------------------------------------------------------------ */

/**
 * Paths refused even with a valid session.
 *
 * IMPORTANT CONTEXT: this list is defence in depth, not the primary control.
 * The real boundary is the restricted Jellyfin policy applied at redemption
 * (IsAdministrator: false and friends) — Jellyfin enforces that on every
 * request by itself. A deny-list of paths can never be complete across Jellyfin
 * versions, so it must not be the only thing standing between a user and an
 * admin endpoint. It is here to fail closed on the specific routes that would
 * be catastrophic, and to catch anything a future Jellyfin release exposes to
 * non-admins that we would rather it did not.
 *
 * Matched case-insensitively against the percent-decoded path, without the
 * leading `/jf/`.
 */
const DENIED_PATHS: readonly RegExp[] = [
  // --- Explicitly named in the brief ---
  /^users\/new\b/,
  /^system(\/|$)/,
  /^scheduledtasks(\/|$)/,

  // --- Would defeat the gateway entirely ---
  // A user who can reach these mints their own Jellyfin token in client-side
  // JavaScript and never has to come back through this app again.
  /^users\/authenticatebyname\b/,
  /^users\/authenticatewithquickconnect\b/,
  /^quickconnect(\/|$)/,
  // API key management: a self-issued key outlives any session revocation.
  /^auth\/keys(\/|$)/,
  /^apikeys(\/|$)/,

  // --- Session lifecycle belongs to this app, not the client ---
  // Allows /Sessions/Playing and /Sessions/Capabilities (needed for playback
  // reporting) while blocking the bare listing and client-driven logout, which
  // would kill a token this app still has a live session row for.
  /^sessions$/,
  /^sessions\/logout\b/,

  // --- User administration ---
  /^users$/,
  /^users\/public\b/,
  /^users\/[^/]+\/policy\b/,
  // No self-service password change: the brief keeps password resets in
  // Jellyfin's own admin panel.
  /^users\/[^/]+\/password\b/,

  // --- Server administration ---
  /^plugins(\/|$)/,
  /^packages(\/|$)/,
  /^repositories(\/|$)/,
  /^startup(\/|$)/,
  /^dashboard(\/|$)/,
  /^web(\/|$)/,
  /^librarystructure(\/|$)/,
  /^library\/(refresh|virtualfolders)\b/,
  /^branding\/configuration\b/,
  /^activitylog(\/|$)/,
  /^notifications\/admin\b/,
  /^devices(\/|$)/,
  // Exposes the host filesystem for library picking. Never reachable from here.
  /^environment(\/|$)/,
];

function isDenied(decodedPath: string): boolean {
  return DENIED_PATHS.some((pattern) => pattern.test(decodedPath));
}

/* ------------------------------------------------------------------ *
 * Header policy
 * ------------------------------------------------------------------ */

/**
 * Request headers forwarded upstream. An allow-list, so nothing unexpected
 * reaches Jellyfin.
 *
 * `range` and `if-range` are the reason seeking works. Drop them and the
 * browser gets a 200 with the whole file for every scrub of the timeline.
 */
const FORWARD_REQUEST_HEADERS = new Set([
  "accept",
  "accept-language",
  "cache-control",
  "content-type",
  "if-modified-since",
  "if-none-match",
  "if-range",
  "range",
  "user-agent",
  "x-emby-authorization",
]);

/**
 * Response headers never passed back.
 *
 * Hop-by-hop headers are per-connection and meaningless to forward. `set-cookie`
 * is dropped so Jellyfin can never set a cookie in the user's browser — the only
 * cookie on this origin is ours.
 */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "set-cookie",
]);

function buildUpstreamHeaders(
  request: Request,
  token: string,
  deviceId: string,
): Headers {
  const headers = new Headers();

  for (const [key, value] of request.headers) {
    if (FORWARD_REQUEST_HEADERS.has(key.toLowerCase())) {
      headers.set(key, value);
    }
  }

  // The session's Jellyfin token, attached here and nowhere else.
  headers.set(
    "Authorization",
    `MediaBrowser Client="JellyfinGate", Device="Web", DeviceId="${deviceId.replace(
      /["\\,]/g,
      "",
    )}", Version="0.1.0", Token="${token.replace(/["\\,]/g, "")}"`,
  );

  // Ask Jellyfin not to compress. Both processes are on the same box, so the
  // bytes are free, and it saves an i3-6100 from gzipping on the way out and
  // undici from gunzipping on the way in. It also keeps Content-Length exact,
  // which matters for the Range handling below. Compression to the actual
  // client is Cloudflare's job.
  headers.set("Accept-Encoding", "identity");

  return headers;
}

function buildDownstreamHeaders(upstream: Response): Headers {
  const headers = new Headers();

  for (const [key, value] of upstream.headers) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;

    // Defensive: if Jellyfin compressed anyway, undici has already decompressed
    // the body, so the upstream Content-Encoding and Content-Length now both
    // describe bytes that no longer exist. Forwarding either corrupts the
    // response.
    if (lower === "content-encoding") continue;

    headers.set(key, value);
  }

  if (upstream.headers.has("content-encoding")) {
    headers.delete("content-length");
  }

  // Jellyfin advertises this on media endpoints, but assert it for any 206 so a
  // client never has to guess whether seeking is supported.
  if (upstream.status === 206 && !headers.has("accept-ranges")) {
    headers.set("Accept-Ranges", "bytes");
  }

  headers.set("Cache-Control", headers.get("cache-control") ?? "private, no-store");
  return headers;
}

/* ------------------------------------------------------------------ *
 * HLS playlist sanitising
 * ------------------------------------------------------------------ */

/**
 * Jellyfin embeds a live access token in the HLS playlists it generates, so
 * playlist bodies are rewritten before they reach the browser rather than piped
 * through. See src/lib/strip-credentials.ts for what is removed and why.
 *
 * Buffering is safe here and nowhere else in this file: playlists are a few
 * kilobytes of text. The cap below makes that assumption explicit rather than
 * implicit, so a surprising response cannot turn into an unbounded allocation.
 */
const PLAYLIST_CONTENT_TYPES = [
  "application/vnd.apple.mpegurl",
  "application/x-mpegurl",
  "audio/mpegurl",
  "audio/x-mpegurl",
];

const MAX_PLAYLIST_BYTES = 4 * 1024 * 1024;

function isPlaylist(decodedPath: string, upstream: Response): boolean {
  if (decodedPath.endsWith(".m3u8") || decodedPath.endsWith(".m3u")) return true;
  const contentType = (upstream.headers.get("content-type") ?? "").toLowerCase();
  return PLAYLIST_CONTENT_TYPES.some((type) => contentType.includes(type));
}

async function sanitisePlaylist(
  upstream: Response,
  headers: Headers,
): Promise<Response> {
  const declared = Number(upstream.headers.get("content-length") ?? "0");
  if (declared > MAX_PLAYLIST_BYTES) {
    console.error(`[jf] refusing to rewrite oversized playlist (${declared} bytes)`);
    return new Response(
      "#EXTM3U\n# playlist too large to sanitise\n",
      { status: 502, headers: { "Content-Type": "application/vnd.apple.mpegurl" } },
    );
  }

  const original = await upstream.text();
  const sanitised = stripCredentials(original);

  // The body changed length, so the upstream value is now a lie.
  headers.delete("content-length");
  headers.set("Cache-Control", "no-store");

  return new Response(sanitised, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

/* ------------------------------------------------------------------ *
 * Handler
 * ------------------------------------------------------------------ */

const METHODS_WITHOUT_BODY = new Set(["GET", "HEAD", "OPTIONS", "DELETE"]);
/** Statuses that must not carry a body, per RFC 9110. */
const BODYLESS_STATUSES = new Set([101, 204, 205, 304]);

async function proxy(request: Request): Promise<Response> {
  const session = getSessionFromRequest(request);
  if (!session) {
    return Response.json(
      { error: "unauthenticated", message: "Sign in to continue." },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  const url = new URL(request.url);
  // Taken from the raw pathname rather than the route's catch-all params: Next
  // percent-decodes params, and re-encoding them would mangle ids containing
  // reserved characters. This keeps the original encoding byte for byte.
  const rawPath = url.pathname.replace(/^\/jf\/?/, "");

  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(rawPath).toLowerCase();
  } catch {
    return Response.json(
      { error: "bad_request", message: "Malformed path." },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  // Traversal check before the deny-list, so `/jf/Items/../System/Info` cannot
  // walk out of a permitted prefix into a denied one.
  if (decodedPath.includes("..")) {
    return Response.json(
      { error: "forbidden", message: "Path not permitted." },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  }

  if (isDenied(decodedPath)) {
    console.warn(
      `[jf] denied ${request.method} /${decodedPath} for user ${session.username}`,
    );
    return Response.json(
      { error: "forbidden", message: "This endpoint is not available through this server." },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  }

  const target = `${env.jellyfinUrl}/${rawPath}${url.search}`;

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers: buildUpstreamHeaders(request, session.jellyfinToken, session.jellyfinDeviceId),
      body: METHODS_WITHOUT_BODY.has(request.method) ? undefined : request.body,
      // Required by the fetch spec when the body is a stream: tells undici we
      // will finish sending before reading the response.
      duplex: "half",
      // Never follow a redirect server-side; hand it to the browser so relative
      // URLs resolve against this origin rather than leaking Jellyfin's.
      redirect: "manual",
      // Propagates the client hanging up mid-stream, so abandoning a video
      // tears down the upstream request instead of leaving Jellyfin transcoding
      // into nothing. This matters a lot on a CPU-constrained box.
      signal: request.signal,
      cache: "no-store",
    } as RequestInit & { duplex: "half" });
  } catch (error) {
    if (request.signal.aborted) {
      // Client went away. Not an error worth logging.
      return new Response(null, { status: 499 });
    }
    console.error(`[jf] upstream fetch failed for ${request.method} /${decodedPath}:`, error);
    return Response.json(
      { error: "upstream_unavailable", message: "The media server is not responding." },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }

  const headers = buildDownstreamHeaders(upstream);

  // Sliding renewal. `touchSession` is a no-op until the session has burned
  // most of its lifetime, which keeps a seek-heavy playback session from
  // issuing a SQLite write per Range request.
  try {
    if (touchSession(session)) {
      headers.append("Set-Cookie", sessionCookie(session.sessionId));
    }
  } catch (error) {
    console.warn("[jf] session renewal failed:", error);
  }

  // Playlists are the one response type that must be read and rewritten rather
  // than piped, because Jellyfin embeds a live access token in the body.
  if (
    request.method !== "HEAD" &&
    upstream.ok &&
    upstream.body &&
    isPlaylist(decodedPath, upstream)
  ) {
    return sanitisePlaylist(upstream, headers);
  }

  // The body is handed straight through as a stream. `upstream.body` is a
  // ReadableStream that Node pipes to the socket; nothing here ever holds a
  // frame of video in memory. An `await upstream.arrayBuffer()` in this spot
  // would try to allocate the entire file on an 8 GB box.
  const body =
    request.method === "HEAD" || BODYLESS_STATUSES.has(upstream.status)
      ? null
      : upstream.body;

  return new Response(body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

export const GET = proxy;
export const HEAD = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const OPTIONS = proxy;
