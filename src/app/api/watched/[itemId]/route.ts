import { invalidate } from "@/lib/cache";
import { JellyfinError, setPlayed } from "@/lib/jellyfin";
import { getSessionFromRequest } from "@/lib/session";
import { readJsonBody } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * POST /api/watched/:itemId  { watched: boolean }
 *
 * Marks a film or episode as watched, or as not watched, for the signed-in
 * viewer. Jellyfin holds the answer: marking something watched also clears
 * where they stopped, which is what takes it out of Continue watching.
 *
 * Per-user like lists: the session decides whose history is touched.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ itemId: string }> },
): Promise<Response> {
  const session = getSessionFromRequest(request);
  if (!session) {
    return Response.json(
      { error: "unauthenticated", message: "Sign in to continue." },
      { status: 401, headers: NO_STORE },
    );
  }

  const { itemId } = await context.params;
  let watched: unknown;
  try {
    watched = (await readJsonBody(request)).watched;
  } catch {
    watched = undefined;
  }
  if (typeof watched !== "boolean" || !/^[0-9a-f-]{32,36}$/i.test(itemId)) {
    return Response.json(
      { error: "invalid_request", message: "watched must be true or false." },
      { status: 400, headers: NO_STORE },
    );
  }

  try {
    await setPlayed(session.jellyfinToken, session.jellyfinDeviceId, session.jellyfinUserId, itemId, watched);
    // The cached listing carries each viewer's watched marks; without this
    // the tick (and "hide what I've seen") would lag a minute behind.
    invalidate("all-movies");
    return Response.json({ ok: true, watched }, { headers: NO_STORE });
  } catch (error) {
    const missing = error instanceof JellyfinError && error.status === 404;
    if (!missing) console.error("[watched] failed:", error);
    return Response.json(
      { error: missing ? "not_found" : "upstream_error", message: "Could not change that." },
      { status: missing ? 404 : 502, headers: NO_STORE },
    );
  }
}
