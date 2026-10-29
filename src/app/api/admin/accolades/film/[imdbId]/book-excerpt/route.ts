import { requireAdmin } from "@/lib/admin-auth";
import { BookExcerptTooLong, clearBookExcerpt, setBookExcerpt } from "@/lib/scraping/book-excerpts";
import { optionalString, readJsonBody, ValidationError } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * POST /api/admin/accolades/film/{imdbId}/book-excerpt { article_id, text }
 * The excerpt from an uploaded book shown under "Read more" when the film
 * ends (book-excerpts.ts). Replaces any earlier one from the same book.
 */
export async function POST(request: Request, { params }: { params: Promise<{ imdbId: string }> }): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const { imdbId } = await params;
  try {
    const body = await readJsonBody(request);
    const articleId = optionalString(body, "article_id");
    const text = optionalString(body, "text");
    if (!articleId || !text?.trim()) throw new ValidationError("article_id and text are required.");
    setBookExcerpt(imdbId, articleId, text);
    return Response.json({ ok: true }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof ValidationError || error instanceof BookExcerptTooLong) {
      return Response.json({ error: "invalid_request", message: error.message }, { status: 400, headers: NO_STORE });
    }
    console.error("[accolades/book-excerpt] failed:", error);
    return Response.json({ error: "internal_error", message: "Could not save the excerpt." }, { status: 500, headers: NO_STORE });
  }
}

/** DELETE ?article_id= — that book no longer offers anything for this film. */
export async function DELETE(request: Request, { params }: { params: Promise<{ imdbId: string }> }): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const { imdbId } = await params;
  const articleId = new URL(request.url).searchParams.get("article_id");
  if (!articleId) {
    return Response.json({ error: "invalid_request", message: "article_id is required." }, { status: 400, headers: NO_STORE });
  }
  clearBookExcerpt(imdbId, articleId);
  return Response.json({ ok: true }, { headers: NO_STORE });
}
