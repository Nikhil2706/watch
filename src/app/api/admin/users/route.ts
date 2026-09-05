import { requireAdmin } from "@/lib/admin-auth";
import { asRows, getDb } from "@/lib/db";
import { getUser } from "@/lib/jellyfin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * GET /api/admin/users
 *
 * Started as just enough to populate a target picker (Curator's Pick) — id +
 * username, most recently active first. Now also carries langlois_mode and
 * parental_control so the Invites tab's Users list can show and toggle each
 * per account, and
 * is_admin so that list can grey out the toggle for a real Jellyfin
 * administrator rather than let a curator click it and hit a confusing
 * error — createSessionForLogin() upserts a row here for anyone who logs
 * into the gate, including the server's own admin using their day-to-day
 * account, and applyRestrictedPolicy() always strips admin rights, which
 * PATCH /api/admin/users/:id refuses for exactly this reason. The
 * per-user Jellyfin lookups run in parallel; the user list here is small
 * (invited friends/family, not a public service) so this stays cheap.
 */
export async function GET(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const users = asRows<{
    id: string;
    username: string;
    last_seen_at: number;
    langlois_mode: number;
    parental_control: number;
    suspended: number;
    jellyfin_user_id: string;
  }>(
    getDb()
      .prepare(
        "SELECT id, username, last_seen_at, langlois_mode, parental_control, suspended, jellyfin_user_id FROM users ORDER BY last_seen_at DESC",
      )
      .all(),
  );

  const withAdminStatus = await Promise.all(
    users.map(async (u) => {
      let isAdmin = false;
      try {
        const jellyfinUser = await getUser(u.jellyfin_user_id);
        isAdmin = jellyfinUser.Policy?.IsAdministrator === true;
      } catch {
        // Jellyfin unreachable or the account is gone — defaults to false,
        // same as "unknown" being treated as "not an admin" is the safer
        // direction for a display-only flag (worst case the toggle shows
        // enabled and the PATCH route's own check catches it for real).
      }
      return {
        id: u.id,
        username: u.username,
        last_seen_at: u.last_seen_at,
        langlois_mode: u.langlois_mode === 1,
        parental_control: u.parental_control === 1,
        suspended: u.suspended === 1,
        is_admin: isAdmin,
      };
    }),
  );

  return Response.json({ users: withAdminStatus }, { headers: NO_STORE });
}
