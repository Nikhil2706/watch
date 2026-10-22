import { setActivityVisibility } from "@/lib/friends";
import { getDb } from "@/lib/db";
import { getSessionFromRequest } from "@/lib/session";
import { readJsonBody } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * POST /api/prefs  { hideWatched?: boolean, activityVisibility?: "friends" | "nobody" }
 *
 * A viewer's own settings, kept on their account so they follow them from
 * phone to TV:
 *  - hideWatched: hide what they have already seen from the places that
 *    suggest something to watch;
 *  - activityVisibility: whether friends see what they watch, rate and
 *    review (Home's friends rows; friends-feed.ts).
 */
export async function POST(request: Request): Promise<Response> {
  const session = getSessionFromRequest(request);
  if (!session) {
    return Response.json(
      { error: "unauthenticated", message: "Sign in to continue." },
      { status: 401, headers: NO_STORE },
    );
  }

  let body: Record<string, unknown> = {};
  try {
    body = await readJsonBody(request);
  } catch {
    /* invalid JSON: answered below as missing fields */
  }
  const { hideWatched, activityVisibility } = body;
  const hideOk = hideWatched === undefined || typeof hideWatched === "boolean";
  const visibilityOk =
    activityVisibility === undefined || activityVisibility === "friends" || activityVisibility === "nobody";
  if (!hideOk || !visibilityOk || (hideWatched === undefined && activityVisibility === undefined)) {
    return Response.json(
      {
        error: "invalid_request",
        message: 'Send hideWatched (true or false) or activityVisibility ("friends" or "nobody").',
      },
      { status: 400, headers: NO_STORE },
    );
  }

  if (typeof hideWatched === "boolean") {
    getDb().prepare("UPDATE users SET hide_watched = ? WHERE id = ?").run(hideWatched ? 1 : 0, session.userId);
  }
  if (activityVisibility === "friends" || activityVisibility === "nobody") {
    setActivityVisibility(session.userId, activityVisibility);
  }
  return Response.json({ ok: true, hideWatched, activityVisibility }, { headers: NO_STORE });
}
