import { requireAdmin } from "@/lib/admin-auth";
import { notifyUsers } from "@/lib/notifications";
import { readJsonBody, ValidationError } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * POST /api/admin/notifications/curators-pick
 * Body: { imdbId, filmTitle, filmHref, userIds: string[] }
 *
 * Sends a "Curator's Pick — Just For You" notification to specific users,
 * picked by the curator in the console. Kept deliberately targeted (not a
 * broadcast) — see notifyAllUsers for the "everyone" case, used only for
 * new library items.
 */
export async function POST(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  try {
    const body = await readJsonBody(request);
    const imdbId = body.imdbId;
    const filmTitle = body.filmTitle;
    const filmHref = body.filmHref;
    const userIds = body.userIds;

    if (typeof imdbId !== "string" || !imdbId.trim()) {
      throw new ValidationError("imdbId is required.");
    }
    if (typeof filmTitle !== "string" || !filmTitle.trim()) {
      throw new ValidationError("filmTitle is required.");
    }
    if (typeof filmHref !== "string" || !filmHref.trim()) {
      throw new ValidationError("filmHref is required.");
    }
    if (!Array.isArray(userIds) || userIds.length === 0 || !userIds.every((id) => typeof id === "string")) {
      throw new ValidationError("userIds must be a non-empty array of strings.");
    }

    const notified = notifyUsers(userIds, { kind: "curators_pick", imdbId, filmTitle, filmHref });
    return Response.json({ ok: true, notified }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof ValidationError) {
      return Response.json({ error: "invalid_request", message: error.message }, { status: 400, headers: NO_STORE });
    }
    console.error("[admin/notifications/curators-pick] failed:", error);
    return Response.json({ error: "internal_error", message: "Could not send the notification." }, { status: 500, headers: NO_STORE });
  }
}
