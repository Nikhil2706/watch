import { requireAdmin } from "@/lib/admin-auth";
import { editCustomTriviaSelection, removeTriviaSelection } from "@/lib/scraping/trivia";
import { optionalString, readJsonBody, ValidationError } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * PATCH /api/admin/accolades/film/{imdbId}/trivia/{selectionId}  { text }
 *
 * Only edits a curator-typed fact in place. A candidate-sourced fact has no
 * text of its own to edit here — remove it and add a custom one instead.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ selectionId: string }> },
): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const { selectionId } = await params;

  try {
    const body = await readJsonBody(request);
    const text = optionalString(body, "text");
    if (!text || !text.trim()) throw new ValidationError("text is required.");

    const edited = editCustomTriviaSelection(selectionId, text.trim());
    if (!edited) {
      return Response.json(
        { error: "not_found", message: "No such custom fact (a source-provided fact can't be edited here)." },
        { status: 404, headers: NO_STORE },
      );
    }
    return Response.json({ ok: true }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof ValidationError) {
      return Response.json({ error: "invalid_request", message: error.message }, { status: 400, headers: NO_STORE });
    }
    console.error("[accolades/trivia] edit failed:", error);
    return Response.json({ error: "internal_error", message: "Could not save the fact." }, { status: 500, headers: NO_STORE });
  }
}

/** DELETE /api/admin/accolades/film/{imdbId}/trivia/{selectionId} — removing the LAST one returns the film to "auto" (random candidates). */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ imdbId: string; selectionId: string }> },
): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const { selectionId } = await params;
  const removed = removeTriviaSelection(selectionId);
  if (!removed) {
    return Response.json({ error: "not_found", message: "No such trivia selection." }, { status: 404, headers: NO_STORE });
  }
  return Response.json({ ok: true }, { headers: NO_STORE });
}
