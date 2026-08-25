import { pollDevicePairing } from "@/lib/device-pairing";
import { getClientIp, getUserAgent } from "@/lib/ip";
import { checkRateLimit, DEVICE_POLL_LIMIT, rateLimitHeaders } from "@/lib/ratelimit";
import { sessionCookie } from "@/lib/session";
import { readJsonBody, ValidationError } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * POST /api/auth/device/poll { pairId } — the TV asks "has someone approved
 * me yet?". Unauthenticated by necessity (the whole point is the TV has no
 * session yet); rate-limited generously since a legitimate pairing screen
 * polls this every couple of seconds for up to five minutes.
 *
 * On success this sets the session cookie directly on THIS response — the
 * TV's own browser made this request, so a normal Set-Cookie reaches it,
 * exactly like /api/auth/login.
 */
export async function POST(request: Request): Promise<Response> {
  const ip = getClientIp(request);
  const limit = checkRateLimit(DEVICE_POLL_LIMIT, ip);
  if (!limit.allowed) {
    return Response.json(
      { error: "rate_limited", message: "Polling too fast." },
      { status: 429, headers: { ...NO_STORE, ...rateLimitHeaders(DEVICE_POLL_LIMIT, limit) } },
    );
  }

  let pairId: string;
  try {
    const body = await readJsonBody(request);
    if (typeof body.pairId !== "string" || body.pairId === "") {
      throw new ValidationError("pairId is required.");
    }
    pairId = body.pairId;
  } catch (error) {
    const message = error instanceof ValidationError ? error.message : "Invalid request.";
    return Response.json({ error: "invalid_request", message }, { status: 400, headers: NO_STORE });
  }

  try {
    const result = await pollDevicePairing(pairId, getUserAgent(request), ip);

    if (result.status === "pending") {
      return Response.json({ status: "pending" }, { status: 200, headers: NO_STORE });
    }
    if (result.status === "expired") {
      return Response.json({ status: "expired" }, { status: 404, headers: NO_STORE });
    }

    return Response.json(
      { status: "authenticated", username: result.username },
      { status: 200, headers: { ...NO_STORE, "Set-Cookie": sessionCookie(result.sessionId) } },
    );
  } catch (error) {
    console.error("[auth/device/poll]", error);
    return Response.json(
      { error: "upstream_error", message: "The media server returned an unexpected response." },
      { status: 502, headers: NO_STORE },
    );
  }
}
