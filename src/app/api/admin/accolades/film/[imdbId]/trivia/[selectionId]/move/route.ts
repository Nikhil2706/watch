import { requireAdmin } from "@/lib/admin-auth";
import { moveTriviaSelection } from "@/lib/scraping/trivia";
import { readJsonBody, ValidationError } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** POST /api/admin/accolades/film/{imdbId}/trivia/{selectionId}/move  { direction: "up" | "down" } */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ imdbId: string; selectionId: string }> },
): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const { imdbId, selectionId } = await params;

  try {
    const body = await readJsonBody(request);
    const direction = body.direction;
    if (direction !== "up" && direction !== "down") {
      throw new ValidationError('direction must be "up" or "down".');
    }

    const moved = moveTriviaSelection(imdbId, selectionId, direction);
    if (!moved) {
      return Response.json(
        { error: "not_found", message: "Already at that end of the list, or no such fact." },
        { status: 404, headers: NO_STORE },
      );
    }
    return Response.json({ ok: true }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof ValidationError) {
      return Response.json({ error: "invalid_request", message: error.message }, { status: 400, headers: NO_STORE });
    }
    console.error("[accolades/trivia/move] failed:", error);
    return Response.json({ error: "internal_error", message: "Could not reorder." }, { status: 500, headers: NO_STORE });
  }
}
