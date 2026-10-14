import "server-only";

import { decideAdmin, type AdminDecision } from "./admin-access";
import { constantTimeEqual } from "./crypto";
import { env } from "./env";
import { getSessionFromRequest } from "./session";

/**
 * Gate for /api/admin/*.
 *
 * Two ways in (see admin-access.ts for the rules): the static key, sent as
 * `X-Admin-Key` — scripts, the Mac's helpers and the old console use it, and
 * a browser never attaches it on its own — or the session of an account with
 * users.is_admin set, for the /admin pages, which only counts for requests
 * from this site itself.
 *
 * The comparison is constant-time. A naive `===` on a secret returns as soon as
 * it hits a differing byte, and that timing difference is measurable over a
 * network — enough to recover the key byte by byte. `constantTimeEqual` hashes
 * both sides to fixed-length buffers first, so neither the length nor the
 * content of the supplied value changes how long the check takes.
 */
export function isAuthorizedAdmin(request: Request): boolean {
  return adminDecision(request).ok;
}

/**
 * The full decision (admin-access.ts): the key header, or the session of an
 * account with users.is_admin set, from this site only.
 */
export function adminDecision(request: Request): AdminDecision {
  const provided = request.headers.get("x-admin-key");
  // Still burn a comparison when there is no header, so a missing header is
  // not measurably faster than a wrong one.
  const keyMatches = constantTimeEqual(provided ?? "", env.adminApiKey);
  const keyHeader = provided === null ? "absent" : keyMatches ? "valid" : "invalid";
  const session = keyHeader === "absent" ? getSessionFromRequest(request) : null;
  const host = request.headers.get("host");
  return decideAdmin({
    method: request.method,
    keyHeader,
    session: session ? { username: session.username, isAdmin: session.isAdmin, suspended: false } : null,
    secFetchSite: request.headers.get("sec-fetch-site"),
    origin: request.headers.get("origin"),
    ownOrigins: [env.publicUrl, ...(host ? [`https://${host}`, `http://${host}`] : [])],
  });
}

/** Who is acting, for audit fields: the admin's username, or "admin key". */
export function adminActor(request: Request): string | null {
  const d = adminDecision(request);
  if (!d.ok) return null;
  return d.via === "session" ? d.username : "admin key";
}

/** Returns a 401 (403 for a signed-in non-admin) when unauthorised, or null to continue. */
export function requireAdmin(request: Request): Response | null {
  const d = adminDecision(request);
  if (d.ok) return null;
  const forbidden = d.reason === "not-admin" || d.reason === "cross-site";
  return Response.json(
    {
      error: forbidden ? "forbidden" : "unauthorized",
      message: forbidden
        ? "This account can't use the curator's tools."
        : "Valid X-Admin-Key header, or an admin's session, required.",
    },
    { status: forbidden ? 403 : 401, headers: { "Cache-Control": "no-store" } },
  );
}
