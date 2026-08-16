import { pruneExpiredSessions } from "@/lib/db";
import { logEvent } from "@/lib/events";
import { getClientIp, getUserAgent } from "@/lib/ip";
import {
  authenticateByName,
  generateDeviceId,
  JellyfinError,
} from "@/lib/jellyfin";
import {
  checkRateLimit,
  LOGIN_LIMIT,
  rateLimitHeaders,
} from "@/lib/ratelimit";
import { createSessionForLogin, sessionCookie } from "@/lib/session";
import { readJsonBody, ValidationError } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * POST /api/auth/login  { username, password } -> sets the session cookie.
 *
 * Credentials are forwarded to Jellyfin and nothing else. This app has no
 * password store and no way to verify a password itself — Jellyfin is the
 * identity source of truth.
 *
 * The Jellyfin AccessToken that comes back is written to the session row and
 * never included in this response. The browser receives only the opaque session
 * id, in an httpOnly cookie.
 */
export async function POST(request: Request): Promise<Response> {
  const ip = getClientIp(request);

  // 5 attempts per IP per 15 minutes, counted before any Jellyfin work so a
  // flood costs us a Map lookup rather than an upstream round-trip.
  const limit = checkRateLimit(LOGIN_LIMIT, ip);
  if (!limit.allowed) {
    return Response.json(
      {
        error: "rate_limited",
        message: `Too many login attempts. Try again in ${limit.retryAfterSeconds} seconds.`,
      },
      { status: 429, headers: { ...NO_STORE, ...rateLimitHeaders(LOGIN_LIMIT, limit) } },
    );
  }

  let username: string;
  let password: string;
  try {
    const body = await readJsonBody(request);
    // Login does not apply the registration charset rules — an account may
    // predate this app, or have been created directly in Jellyfin.
    if (typeof body.username !== "string" || body.username.trim() === "") {
      throw new ValidationError("Username is required.");
    }
    if (typeof body.password !== "string" || body.password === "") {
      throw new ValidationError("Password is required.");
    }
    username = body.username.trim();
    password = body.password;
  } catch (error) {
    const message =
      error instanceof ValidationError ? error.message : "Invalid request.";
    return Response.json(
      { error: "invalid_request", message },
      { status: 400, headers: NO_STORE },
    );
  }

  const deviceId = generateDeviceId();

  let auth;
  try {
    auth = await authenticateByName(username, password, deviceId);
  } catch (error) {
    if (error instanceof JellyfinError && error.status === 0) {
      console.error("[auth/login] Jellyfin unreachable:", error.message);
      logEvent({
        category: "internal_api",
        severity: "error",
        source: "auth_login",
        message: "Jellyfin unreachable during login",
        detail: { error: error.message },
        username,
      });
      return Response.json(
        { error: "upstream_unavailable", message: "The media server is not responding." },
        { status: 502, headers: NO_STORE },
      );
    }
    // Anything else from Jellyfin on this endpoint means bad credentials or a
    // disabled account. Never distinguish the two to the caller — doing so
    // turns this into a username oracle.
    return Response.json(
      { error: "invalid_credentials", message: "Incorrect username or password." },
      { status: 401, headers: { ...NO_STORE, ...rateLimitHeaders(LOGIN_LIMIT, limit) } },
    );
  }

  if (!auth?.AccessToken || !auth.User?.Id) {
    console.error("[auth/login] Unexpected Jellyfin auth payload shape.");
    logEvent({
      category: "internal_api",
      severity: "error",
      source: "auth_login",
      message: "Jellyfin returned an unexpected auth payload shape",
      username,
    });
    return Response.json(
      { error: "upstream_error", message: "The media server returned an unexpected response." },
      { status: 502, headers: NO_STORE },
    );
  }

  // Opportunistic housekeeping; a single indexed DELETE, cheap enough to run on
  // a path that only fires a few times a day.
  try {
    pruneExpiredSessions();
  } catch (error) {
    console.warn("[auth/login] session prune failed:", error);
  }

  const sessionId = createSessionForLogin({
    jellyfinUserId: auth.User.Id,
    username: auth.User.Name ?? username,
    jellyfinToken: auth.AccessToken,
    jellyfinDeviceId: deviceId,
    userAgent: getUserAgent(request),
    ip,
  });

  return Response.json(
    { ok: true, username: auth.User.Name ?? username },
    {
      status: 200,
      headers: { ...NO_STORE, "Set-Cookie": sessionCookie(sessionId) },
    },
  );
}
