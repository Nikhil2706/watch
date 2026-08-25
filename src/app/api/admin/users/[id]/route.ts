import { requireAdmin } from "@/lib/admin-auth";
import { asRow, getDb } from "@/lib/db";
import { applyRestrictedPolicy, getUser, JellyfinError } from "@/lib/jellyfin";
import { optionalBoolean, readJsonBody, ValidationError } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * PATCH /api/admin/users/:id  { langlois_mode?: boolean, parental_control?: boolean }
 *
 * Either field, or both, in one request — each applied independently.
 *
 * langlois_mode (raw film/subtitle download access) is the original
 * behaviour here: the database flag is only a record of intent;
 * applyRestrictedPolicy() is what actually flips EnableContentDownloading on
 * the user's real Jellyfin account, which is the thing GET
 * /jf/Items/{id}/Download actually checks. Both are written, in that order —
 * if the Jellyfin call fails, the DB is left untouched rather than recording
 * a grant that was never really applied. Blocked outright for a real
 * Jellyfin administrator account (see the check below) because
 * applyRestrictedPolicy() unconditionally sets IsAdministrator: false.
 *
 * parental_control ("stop showing R-rated or equivalent movies" — see
 * parental-control.ts) is a plain database flag and nothing else: it never
 * touches Jellyfin, so it has none of langlois_mode's failure modes or its
 * admin-account restriction, and can be set even on an admin's own account.
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const { id } = await context.params;

  let langloisMode: boolean | undefined;
  let parentalControl: boolean | undefined;
  try {
    const body = await readJsonBody(request);
    langloisMode = optionalBoolean(body, "langlois_mode");
    parentalControl = optionalBoolean(body, "parental_control");
    if (langloisMode === undefined && parentalControl === undefined) {
      throw new ValidationError("langlois_mode or parental_control is required.");
    }
  } catch (error) {
    if (error instanceof ValidationError) {
      return Response.json({ error: "invalid_request", message: error.message }, { status: 400, headers: NO_STORE });
    }
    return Response.json({ error: "invalid_request", message: "Invalid request." }, { status: 400, headers: NO_STORE });
  }

  const user = asRow<{ jellyfin_user_id: string; username: string }>(
    getDb().prepare("SELECT jellyfin_user_id, username FROM users WHERE id = ?").get(id),
  );
  if (!user) {
    return Response.json({ error: "not_found", message: `No user with id ${id}.` }, { status: 404, headers: NO_STORE });
  }

  if (langloisMode !== undefined) {
    // Real-user accounts (not just invited/restricted ones) can end up in this
    // table too — createSessionForLogin() upserts a row for anyone who logs
    // in, including the site's own Jellyfin administrator using the public
    // login page for their day-to-day account. applyRestrictedPolicy() always
    // sets IsAdministrator: false unconditionally, which Jellyfin itself
    // refuses if it would leave the server with zero admins ("There must be
    // at least one user in the system with administrative access") — caught
    // live testing this exact route against the real admin account. Checking
    // first and refusing with a clear reason beats surfacing that confusing
    // 403 to the curator, and closes the case where Jellyfin WOULDN'T refuse
    // (a second admin account existing) and this would have silently
    // demoted someone.
    try {
      const jellyfinUser = await getUser(user.jellyfin_user_id);
      if (jellyfinUser.Policy?.IsAdministrator) {
        return Response.json(
          {
            error: "forbidden",
            message: `${user.username} is a Jellyfin administrator account — Langlois mode can't be toggled through this route, since doing so would also strip admin access. Manage this account directly in Jellyfin's dashboard if that's really the intent.`,
          },
          { status: 409, headers: NO_STORE },
        );
      }
    } catch (error) {
      console.error(`[admin/users] policy check failed for ${user.username}:`, error);
      return Response.json(
        { error: "upstream_error", message: "Could not check the account's current permissions." },
        { status: 502, headers: NO_STORE },
      );
    }

    try {
      await applyRestrictedPolicy(user.jellyfin_user_id, { langloisMode });
    } catch (error) {
      const message = error instanceof JellyfinError ? error.message : "Could not update the media server permission.";
      console.error(`[admin/users] applyRestrictedPolicy failed for ${user.username}:`, error);
      return Response.json({ error: "upstream_error", message }, { status: 502, headers: NO_STORE });
    }

    getDb().prepare("UPDATE users SET langlois_mode = ? WHERE id = ?").run(langloisMode ? 1 : 0, id);
  }

  if (parentalControl !== undefined) {
    getDb().prepare("UPDATE users SET parental_control = ? WHERE id = ?").run(parentalControl ? 1 : 0, id);
  }

  return Response.json(
    { id, username: user.username, langlois_mode: langloisMode, parental_control: parentalControl },
    { headers: NO_STORE },
  );
}
