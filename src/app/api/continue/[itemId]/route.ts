import { removeFromContinue } from "@/lib/continue-removed";
import { getSessionFromRequest } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * POST /api/continue/:itemId — takes a card out of the signed-in viewer's
 * Continue watching, without marking it watched: a half-watched film keeps
 * its place in Jellyfin, and the card comes back if they play it again (or,
 * for a next episode, watch a later one). See next-up.ts.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ itemId: string }> },
): Promise<Response> {
  const session = getSessionFromRequest(request);
  if (!session) {
    return Response.json({ error: "unauthenticated", message: "Sign in to continue." }, { status: 401, headers: NO_STORE });
  }
  const { itemId } = await context.params;
  if (!/^[0-9a-f-]{32,36}$/i.test(itemId)) {
    return Response.json({ error: "invalid_request", message: "That isn't an item." }, { status: 400, headers: NO_STORE });
  }
  removeFromContinue(session.userId, itemId);
  return Response.json({ ok: true }, { headers: NO_STORE });
}
