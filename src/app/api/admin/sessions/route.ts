import { requireAdmin } from "@/lib/admin-auth";
import { listSessions } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * GET /api/admin/sessions
 *
 * Not in the original route list, but deliverable #4 asks for a "revoke a
 * session" curl recipe, which needs a way to find the session id first.
 *
 * The `jellyfin_token` column is deliberately excluded from the SELECT rather
 * than filtered afterwards, so it cannot leak through this endpoint even by
 * accident.
 */
export async function GET(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  try {
    const sessions = listSessions().map((row) => ({
      id: row.id,
      username: row.username,
      user_id: row.user_id,
      created_at: new Date(row.created_at).toISOString(),
      expires_at: new Date(row.expires_at).toISOString(),
      ip: row.ip,
      user_agent: row.user_agent,
    }));

    return Response.json({ sessions, count: sessions.length }, { headers: NO_STORE });
  } catch (error) {
    console.error("[admin/sessions] list failed:", error);
    return Response.json(
      { error: "internal_error", message: "Could not list sessions." },
      { status: 500, headers: NO_STORE },
    );
  }
}
