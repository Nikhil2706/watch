import { startDevicePairing } from "@/lib/device-pairing";
import { getClientIp } from "@/lib/ip";
import { JellyfinError } from "@/lib/jellyfin";
import { checkRateLimit, DEVICE_START_LIMIT, rateLimitHeaders } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * POST /api/auth/device/start — a TV, not yet signed in, asks for a fresh
 * pairing code. No request body, no auth: this is the one endpoint an
 * anonymous TV browser is allowed to call, mirroring /api/auth/login's own
 * unauthenticated-by-necessity shape.
 */
export async function POST(request: Request): Promise<Response> {
  const ip = getClientIp(request);
  const limit = checkRateLimit(DEVICE_START_LIMIT, ip);
  if (!limit.allowed) {
    return Response.json(
      {
        error: "rate_limited",
        message: `Too many pairing attempts. Try again in ${limit.retryAfterSeconds} seconds.`,
      },
      { status: 429, headers: { ...NO_STORE, ...rateLimitHeaders(DEVICE_START_LIMIT, limit) } },
    );
  }

  try {
    const { pairId, code, expiresInSeconds } = await startDevicePairing();
    return Response.json({ pairId, code, expiresInSeconds }, { status: 200, headers: NO_STORE });
  } catch (error) {
    if (error instanceof JellyfinError && error.status === 0) {
      return Response.json(
        { error: "upstream_unavailable", message: "The media server is not responding." },
        { status: 502, headers: NO_STORE },
      );
    }
    console.error("[auth/device/start]", error);
    return Response.json(
      { error: "upstream_error", message: "Could not start pairing." },
      { status: 502, headers: NO_STORE },
    );
  }
}
