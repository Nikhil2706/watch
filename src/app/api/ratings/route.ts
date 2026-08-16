import { deleteRating, upsertRating } from "@/lib/community";
import { getSessionFromRequest } from "@/lib/session";
import { optionalInt, optionalString, readJsonBody, ValidationError } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * POST /api/ratings  { imdbId, score }
 *
 * Upsert — rating twice just updates the score. Distinct from OMDb's
 * ratings.ts, which handles the external IMDb/RT/Metacritic numbers; this
 * is the viewers' own.
 */
export async function POST(request: Request): Promise<Response> {
  const session = getSessionFromRequest(request);
  if (!session) {
    return Response.json({ error: "unauthenticated", message: "Sign in to continue." }, { status: 401, headers: NO_STORE });
  }

  try {
    const raw = await readJsonBody(request);
    const imdbId = optionalString(raw, "imdbId");
    const score = optionalInt(raw, "score");
    if (!imdbId) throw new ValidationError("imdbId is required.");
    if (score === undefined) throw new ValidationError("score is required.");

    upsertRating(imdbId, session.userId, score);
    return Response.json({ ok: true }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof ValidationError) {
      return Response.json({ error: "invalid_request", message: error.message }, { status: 400, headers: NO_STORE });
    }
    console.error("[ratings] post failed:", error);
    return Response.json({ error: "internal_error", message: "Could not save your rating." }, { status: 500, headers: NO_STORE });
  }
}

/** DELETE /api/ratings?imdbId= — removes the caller's own rating. */
export async function DELETE(request: Request): Promise<Response> {
  const session = getSessionFromRequest(request);
  if (!session) {
    return Response.json({ error: "unauthenticated", message: "Sign in to continue." }, { status: 401, headers: NO_STORE });
  }

  const imdbId = new URL(request.url).searchParams.get("imdbId");
  if (!imdbId) {
    return Response.json({ error: "invalid_request", message: "imdbId is required." }, { status: 400, headers: NO_STORE });
  }

  deleteRating(imdbId, session.userId);
  return Response.json({ ok: true }, { headers: NO_STORE });
}
