import { logout as jellyfinLogout } from "@/lib/jellyfin";
import {
  clearedSessionCookie,
  destroySession,
  getSessionFromRequest,
} from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * POST /api/auth/logout
 *
 * Three things must happen, in this order:
 *   1. Delete the local session row  — cuts off the /jf/* proxy immediately.
 *   2. Clear the cookie              — tidies up the browser.
 *   3. Call Jellyfin's logout        — invalidates the access token upstream,
 *                                      so the credential is dead even if the
 *                                      database file is later recovered.
 *
 * Step 3 is best-effort: if Jellyfin is down, the user is still logged out here,
 * which is the part under this app's control. Reversing the order would leave a
 * window where Jellyfin had rejected the token but this app still served it.
 */
export async function POST(request: Request): Promise<Response> {
  const session = getSessionFromRequest(request);

  const headers: Record<string, string> = {
    ...NO_STORE,
    "Set-Cookie": clearedSessionCookie(),
  };

  if (!session) {
    // Already logged out. Still clear the cookie and report success, so a stale
    // cookie cannot wedge a client in a state it can't get out of.
    return Response.json({ ok: true }, { headers });
  }

  destroySession(session.sessionId);

  let jellyfinLoggedOut = true;
  try {
    await jellyfinLogout(session.jellyfinToken, session.jellyfinDeviceId);
  } catch (error) {
    jellyfinLoggedOut = false;
    console.warn("[auth/logout] Jellyfin logout failed:", error);
  }

  return Response.json(
    { ok: true, jellyfin_token_invalidated: jellyfinLoggedOut },
    { headers },
  );
}
