import { isListKind, toggleList } from "@/lib/lists";
import { getSessionFromRequest } from "@/lib/session";
import { readJsonBody } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * POST /api/lists/:itemId  { kind: "favourite" | "rewatch" }
 *
 * Toggles membership and returns the new state, so the button can be optimistic
 * without a second round trip to find out what happened.
 *
 * Lists are per-user: the session decides whose list is touched, never the
 * request body. Otherwise anyone could edit anyone else's watchlist.
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

  let kind: unknown;
  try {
    const body = await readJsonBody(request);
    kind = body.kind;
  } catch {
    return Response.json(
      { error: "invalid_request", message: "Malformed body." },
      { status: 400, headers: NO_STORE },
    );
  }

  if (!isListKind(kind)) {
    return Response.json(
      { error: "invalid_request", message: "kind must be favourite or rewatch." },
      { status: 400, headers: NO_STORE },
    );
  }

  const { on } = toggleList(session.userId, itemId, kind);
  return Response.json({ ok: true, kind, on }, { headers: NO_STORE });
}
