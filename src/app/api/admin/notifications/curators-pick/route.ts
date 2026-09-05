import { requireAdmin } from "@/lib/admin-auth";
import { notifyUsers } from "@/lib/notifications";
import { readJsonBody, ValidationError } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * POST /api/admin/notifications/curators-pick
 * Body: { imdbId, filmTitle, filmHref, userIds: string[], note?: string }
 *
 * The optional note is the curator's reason for sending it. It never appears
 * in the notification itself — that text is fixed and stays one line — but it
 * is shown to the recipient on the film's page and on their Picks page, which
 * is where a recommendation is actually read. Capped at 500 characters:
 * long enough for a real thought, short enough to sit above a film without
 * displacing it.
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
    const rawNote = body.note;

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
    if (rawNote !== undefined && rawNote !== null && typeof rawNote !== "string") {
      throw new ValidationError("note must be a string.");
    }
    const note = typeof rawNote === "string" ? rawNote.trim() : "";
    if (note.length > 500) {
      throw new ValidationError("note must be 500 characters or fewer.");
    }

    const notified = notifyUsers(userIds, {
      kind: "curators_pick",
      imdbId,
      filmTitle,
      filmHref,
      note: note || null,
    });
    return Response.json({ ok: true, notified }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof ValidationError) {
      return Response.json({ error: "invalid_request", message: error.message }, { status: 400, headers: NO_STORE });
    }
    console.error("[admin/notifications/curators-pick] failed:", error);
    return Response.json({ error: "internal_error", message: "Could not send the notification." }, { status: 500, headers: NO_STORE });
  }
}
