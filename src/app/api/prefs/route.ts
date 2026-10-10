import { getDb } from "@/lib/db";
import { getSessionFromRequest } from "@/lib/session";
import { readJsonBody } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * POST /api/prefs  { hideWatched: boolean }
 *
 * A viewer's own settings, kept on their account so they follow them from
 * phone to TV. One so far: hide what they have already seen from the places
 * that suggest something to watch.
 */
export async function POST(request: Request): Promise<Response> {
  const session = getSessionFromRequest(request);
  if (!session) {
    return Response.json(
      { error: "unauthenticated", message: "Sign in to continue." },
      { status: 401, headers: NO_STORE },
    );
  }

  let hideWatched: unknown;
  try {
    hideWatched = (await readJsonBody(request)).hideWatched;
  } catch {
    hideWatched = undefined;
  }
  if (typeof hideWatched !== "boolean") {
    return Response.json(
      { error: "invalid_request", message: "hideWatched must be true or false." },
      { status: 400, headers: NO_STORE },
    );
  }

  getDb().prepare("UPDATE users SET hide_watched = ? WHERE id = ?").run(hideWatched ? 1 : 0, session.userId);
  return Response.json({ ok: true, hideWatched }, { headers: NO_STORE });
}
