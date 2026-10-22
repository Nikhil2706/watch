import { getItem } from "@/lib/media";
import { getSessionFromRequest } from "@/lib/session";
import { optionalString, readJsonBody, ValidationError } from "@/lib/validation";
import { askToWatchTogether, TogetherError } from "@/lib/watch-together";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * POST /api/together  { friendId, itemId }
 *
 * Asks a friend who is watching `itemId` to make it a watch party
 * (watch-together.ts). They get a bell notification; nothing else happens
 * until they answer.
 */
export async function POST(request: Request): Promise<Response> {
  const session = getSessionFromRequest(request);
  if (!session) {
    return Response.json({ error: "unauthenticated", message: "Sign in to continue." }, { status: 401, headers: NO_STORE });
  }
  try {
    const body = await readJsonBody(request);
    const friendId = optionalString(body, "friendId");
    const itemId = optionalString(body, "itemId");
    if (!friendId || !itemId) throw new ValidationError("friendId and itemId are required.");
    // Only a title the asker can open themselves.
    const item = await getItem(session, itemId).catch(() => null);
    if (!item) throw new ValidationError("That title isn't in the library.");
    const ask = askToWatchTogether({ fromUserId: session.userId, friendId, item });
    return Response.json({ ok: true, id: ask.id }, { status: 201, headers: NO_STORE });
  } catch (error) {
    if (error instanceof ValidationError || error instanceof TogetherError) {
      const status = error instanceof TogetherError ? error.status : 400;
      return Response.json({ error: "invalid_request", message: error.message }, { status, headers: NO_STORE });
    }
    console.error("[together] ask failed:", error);
    return Response.json({ error: "internal_error", message: "Could not ask them." }, { status: 500, headers: NO_STORE });
  }
}
