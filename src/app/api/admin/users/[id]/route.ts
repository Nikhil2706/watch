import { requireAdmin } from "@/lib/admin-auth";
import { asRow, getDb } from "@/lib/db";
import {
  applyRestrictedPolicy,
  getUser,
  JellyfinError,
  logout as jellyfinLogout,
} from "@/lib/jellyfin";
import { destroySessionsForUser, listSessionsForUser } from "@/lib/session";
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
 *
 * suspended is "revoke this person's access", reversibly. Revoking an INVITE
 * only kills the link — everyone who already signed up with it keeps their
 * account — so this is the only thing in the system that actually cuts
 * somebody off. Three effects, in this order:
 *
 *   1. the flag is written, so a fresh login can't just replace what step 3
 *      deletes;
 *   2. Jellyfin's own IsDisabled is set, which stops the account streaming
 *      even if someone still holds a token;
 *   3. every session the person has is deleted here and logged out upstream,
 *      so a phone already playing something stops too.
 *
 * Deleting the account is deliberately NOT offered: it is unrecoverable, takes
 * their ratings, watchlist and comments with it, and answers no question that
 * suspension doesn't already answer instantly.
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
  let suspended: boolean | undefined;
  try {
    const body = await readJsonBody(request);
    langloisMode = optionalBoolean(body, "langlois_mode");
    parentalControl = optionalBoolean(body, "parental_control");
    suspended = optionalBoolean(body, "suspended");
    if (langloisMode === undefined && parentalControl === undefined && suspended === undefined) {
      throw new ValidationError("langlois_mode, parental_control or suspended is required.");
    }
  } catch (error) {
    if (error instanceof ValidationError) {
      return Response.json({ error: "invalid_request", message: error.message }, { status: 400, headers: NO_STORE });
    }
    return Response.json({ error: "invalid_request", message: "Invalid request." }, { status: 400, headers: NO_STORE });
  }

  const user = asRow<{ jellyfin_user_id: string; username: string; suspended: number }>(
    getDb().prepare("SELECT jellyfin_user_id, username, suspended FROM users WHERE id = ?").get(id),
  );
  if (!user) {
    return Response.json({ error: "not_found", message: `No user with id ${id}.` }, { status: 404, headers: NO_STORE });
  }

  // Everything below writes the account's Jellyfin policy from scratch, and
  // that write needs to know the suspension state it should leave behind — the
  // one being set right now, not the one still in the database.
  const effectiveSuspended = suspended ?? user.suspended === 1;
  let signedOut = 0;

  /*
   * Both langlois_mode and suspended go through applyRestrictedPolicy(), which
   * sets IsAdministrator: false unconditionally — so BOTH have to refuse a
   * real Jellyfin administrator account, not just the Langlois toggle that
   * originally discovered this. Jellyfin refuses the demotion outright when it
   * would leave the server with no admins (caught live testing this route
   * against the real admin account), and where it wouldn't refuse — a second
   * admin exists — this would silently demote someone. Checking once, up
   * front, covers every path below.
   *
   * parental_control is exempt: it is a gate-side flag that never touches
   * Jellyfin at all.
   */
  if (langloisMode !== undefined || suspended !== undefined) {
    try {
      const jellyfinUser = await getUser(user.jellyfin_user_id);
      if (jellyfinUser.Policy?.IsAdministrator) {
        return Response.json(
          {
            error: "forbidden",
            message: `${user.username} is a Jellyfin administrator account — this can't be changed through here, since doing so would also strip admin access. Manage this account directly in Jellyfin's dashboard if that's really the intent.`,
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
  }

  if (suspended !== undefined) {
    try {
      await applyRestrictedPolicy(user.jellyfin_user_id, { suspended });
    } catch (error) {
      const message = error instanceof JellyfinError ? error.message : "Could not update the media server permission.";
      console.error(`[admin/users] suspend policy write failed for ${user.username}:`, error);
      return Response.json({ error: "upstream_error", message }, { status: 502, headers: NO_STORE });
    }

    getDb().prepare("UPDATE users SET suspended = ? WHERE id = ?").run(suspended ? 1 : 0, id);

    if (suspended) {
      /*
       * Sign them out of everything. The local row is what the gate checks on
       * the very next request, so it must go regardless; the upstream logout
       * is best-effort, because a Jellyfin that is briefly unreachable should
       * not leave a suspension half-applied. IsDisabled above already blocks
       * the account server-side either way.
       */
      const sessions = listSessionsForUser(id);
      signedOut = destroySessionsForUser(id);
      for (const session of sessions) {
        try {
          await jellyfinLogout(session.jellyfinToken, session.jellyfinDeviceId);
        } catch (error) {
          console.warn(`[admin/users] Jellyfin logout failed for a session of ${user.username}:`, error);
        }
      }
    }
  }

  if (langloisMode !== undefined) {
    // The administrator refusal that used to live here now runs once, above,
    // because suspension reaches applyRestrictedPolicy() too.
    try {
      await applyRestrictedPolicy(user.jellyfin_user_id, { langloisMode, suspended: effectiveSuspended });
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
    {
      id,
      username: user.username,
      langlois_mode: langloisMode,
      parental_control: parentalControl,
      suspended,
      signed_out: signedOut,
    },
    { headers: NO_STORE },
  );
}
