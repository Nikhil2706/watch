import "server-only";

import { constantTimeEqual } from "./crypto";
import { env } from "./env";

/**
 * Gate for /api/admin/*.
 *
 * A single static key, sent as `X-Admin-Key`, because the brief calls for curl
 * and nothing else. There is no admin UI and no admin session, so there is
 * nothing here for CSRF to target: a browser will never attach this header on
 * its own.
 *
 * The comparison is constant-time. A naive `===` on a secret returns as soon as
 * it hits a differing byte, and that timing difference is measurable over a
 * network — enough to recover the key byte by byte. `constantTimeEqual` hashes
 * both sides to fixed-length buffers first, so neither the length nor the
 * content of the supplied value changes how long the check takes.
 */
export function isAuthorizedAdmin(request: Request): boolean {
  const provided = request.headers.get("x-admin-key");
  if (provided === null) {
    // Still burn a comparison so a missing header is not measurably faster than
    // a wrong one.
    constantTimeEqual("", env.adminApiKey);
    return false;
  }
  return constantTimeEqual(provided, env.adminApiKey);
}

/** Returns a 401 response when unauthorised, or null to continue. */
export function requireAdmin(request: Request): Response | null {
  if (isAuthorizedAdmin(request)) return null;
  return Response.json(
    { error: "unauthorized", message: "Valid X-Admin-Key header required." },
    { status: 401, headers: { "Cache-Control": "no-store" } },
  );
}
