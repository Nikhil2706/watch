import { requireAdmin } from "@/lib/admin-auth";
import { asRows, getDb } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * GET /api/admin/users
 *
 * Just enough to populate a target picker (Curator's Pick) — id + username,
 * most recently active first. No admin route existed for this before now.
 */
export async function GET(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const users = asRows<{ id: string; username: string; last_seen_at: number }>(
    getDb().prepare("SELECT id, username, last_seen_at FROM users ORDER BY last_seen_at DESC").all(),
  );
  return Response.json({ users }, { headers: NO_STORE });
}
