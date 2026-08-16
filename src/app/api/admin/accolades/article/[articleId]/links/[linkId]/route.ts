import { requireAdmin } from "@/lib/admin-auth";
import { getDb } from "@/lib/db";
import { optionalString, readJsonBody, ValidationError } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * POST /api/admin/accolades/article/{articleId}/links/{linkId}
 *   { imdb_id } — the curator confirming a fuzzy guess, or linking a
 *   previously-unmatched mention by hand.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ linkId: string }> },
): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const { linkId } = await params;

  try {
    const body = await readJsonBody(request);
    const imdbId = optionalString(body, "imdb_id");
    if (!imdbId) throw new ValidationError("imdb_id is required.");

    const result = getDb()
      .prepare("UPDATE article_film_links SET imdb_id = ?, confidence = 'exact' WHERE id = ?")
      .run(imdbId, linkId);
    if (Number(result.changes) === 0) {
      return Response.json({ error: "not_found", message: "No such mention." }, { status: 404, headers: NO_STORE });
    }
    return Response.json({ ok: true }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof ValidationError) {
      return Response.json({ error: "invalid_request", message: error.message }, { status: 400, headers: NO_STORE });
    }
    console.error("[accolades/article/links] confirm failed:", error);
    return Response.json({ error: "internal_error", message: "Could not confirm the match." }, { status: 500, headers: NO_STORE });
  }
}

/** DELETE — "not this film" / reject a mention entirely. */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ linkId: string }> },
): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const { linkId } = await params;

  const result = getDb().prepare("DELETE FROM article_film_links WHERE id = ?").run(linkId);
  if (Number(result.changes) === 0) {
    return Response.json({ error: "not_found", message: "No such mention." }, { status: 404, headers: NO_STORE });
  }
  return Response.json({ ok: true }, { headers: NO_STORE });
}
