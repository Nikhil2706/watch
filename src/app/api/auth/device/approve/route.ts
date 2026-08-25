import { approveDevicePairing } from "@/lib/device-pairing";
import { getClientIp } from "@/lib/ip";
import { checkRateLimit, DEVICE_APPROVE_LIMIT, rateLimitHeaders } from "@/lib/ratelimit";
import { getSessionFromRequest } from "@/lib/session";
import { readJsonBody, ValidationError } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * POST /api/auth/device/approve { code } — called from the /pair page by a
 * browser that is ALREADY signed in. Authenticated by the normal session
 * cookie, same as every other mutating route in this app; there is no
 * separate credential for this step because there does not need to be one
 * — Jellyfin authorizes the code using this person's own existing token.
 */
export async function POST(request: Request): Promise<Response> {
  const session = getSessionFromRequest(request);
  if (!session) {
    return Response.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  }

  const ip = getClientIp(request);
  const limit = checkRateLimit(DEVICE_APPROVE_LIMIT, ip);
  if (!limit.allowed) {
    return Response.json(
      { error: "rate_limited", message: "Too many attempts. Try again shortly." },
      { status: 429, headers: { ...NO_STORE, ...rateLimitHeaders(DEVICE_APPROVE_LIMIT, limit) } },
    );
  }

  let code: string;
  try {
    const body = await readJsonBody(request);
    if (typeof body.code !== "string" || body.code.trim() === "") {
      throw new ValidationError("A code is required.");
    }
    code = body.code.trim();
  } catch (error) {
    const message = error instanceof ValidationError ? error.message : "Invalid request.";
    return Response.json({ error: "invalid_request", message }, { status: 400, headers: NO_STORE });
  }

  try {
    const ok = await approveDevicePairing(code, session.jellyfinToken, session.jellyfinDeviceId);
    if (!ok) {
      return Response.json(
        { error: "invalid_code", message: "That code is wrong or has expired." },
        { status: 400, headers: NO_STORE },
      );
    }
    return Response.json({ ok: true }, { status: 200, headers: NO_STORE });
  } catch (error) {
    console.error("[auth/device/approve]", error);
    return Response.json(
      { error: "invalid_code", message: "That code is wrong or has expired." },
      { status: 400, headers: NO_STORE },
    );
  }
}
