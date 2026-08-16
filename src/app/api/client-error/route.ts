import { logEvent } from "@/lib/events";
import { getClientIp } from "@/lib/ip";
import { checkRateLimit, CLIENT_ERROR_LIMIT, rateLimitHeaders } from "@/lib/ratelimit";
import { getSessionFromRequest } from "@/lib/session";
import { readJsonBody } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

const KNOWN_SOURCES = new Set(["player", "react_boundary"]);
const MAX_MESSAGE_CHARS = 500;

/**
 * POST /api/client-error  { source, message, detail?, itemId? }
 *
 * The one place a real viewer's browser reports back: a video that failed to
 * decode or wouldn't load (source: "player" — this is how a corrupt or
 * unsupported file shows up), or a React render crash (source:
 * "react_boundary"). No session is required — a crash on the login page is
 * still worth knowing about — but it is rate-limited per IP, since this is
 * the one log source anyone who can reach the site can trigger.
 *
 * Always returns 204 even when the report itself is malformed: a broken
 * error-reporting call must never surface as a second error to the user.
 */
export async function POST(request: Request): Promise<Response> {
  const ip = getClientIp(request);
  const limit = checkRateLimit(CLIENT_ERROR_LIMIT, ip);
  if (!limit.allowed) {
    return new Response(null, { status: 204, headers: { ...NO_STORE, ...rateLimitHeaders(CLIENT_ERROR_LIMIT, limit) } });
  }

  try {
    const body = await readJsonBody(request);
    const source = typeof body.source === "string" && KNOWN_SOURCES.has(body.source) ? body.source : "client";
    const message =
      typeof body.message === "string" && body.message.trim() !== ""
        ? body.message.trim().slice(0, MAX_MESSAGE_CHARS)
        : "Unspecified client error";
    const itemId = typeof body.itemId === "string" ? body.itemId.slice(0, 100) : null;

    const session = getSessionFromRequest(request);

    logEvent({
      category: source === "player" ? "playback" : "client",
      severity: "error",
      source,
      message,
      detail: body.detail,
      itemId,
      username: session?.username ?? null,
    });
  } catch {
    // Malformed report — nothing to log, nothing to surface to the caller.
  }

  return new Response(null, { status: 204, headers: NO_STORE });
}
