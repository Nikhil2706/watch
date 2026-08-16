import { requireAdmin } from "@/lib/admin-auth";
import { addCustomTriviaSelection, addTriviaCandidateSelection } from "@/lib/scraping/trivia";
import { optionalString, readJsonBody, ValidationError } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * POST /api/admin/accolades/film/{imdbId}/trivia
 *   { candidate_id } to add a scraped candidate to the curated list, or
 *   { text } for a curator-typed fact.
 *
 * Trivia is a list, not a single lock — the FIRST addition for a film
 * switches it from "auto" (random candidates) to "curated" (exactly what's
 * been added, in order); there is no separate lock/unlock step.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ imdbId: string }> },
): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const { imdbId } = await params;

  try {
    const body = await readJsonBody(request);
    const candidateId = optionalString(body, "candidate_id");
    const text = optionalString(body, "text");

    if (candidateId) {
      addTriviaCandidateSelection(imdbId, candidateId);
    } else if (text) {
      addCustomTriviaSelection(imdbId, text);
    } else {
      throw new ValidationError("Provide either candidate_id or text.");
    }

    return Response.json({ ok: true }, { status: 201, headers: NO_STORE });
  } catch (error) {
    if (error instanceof ValidationError) {
      return Response.json({ error: "invalid_request", message: error.message }, { status: 400, headers: NO_STORE });
    }
    console.error("[accolades/trivia] add failed:", error);
    return Response.json({ error: "internal_error", message: "Could not add the trivia fact." }, { status: 500, headers: NO_STORE });
  }
}
