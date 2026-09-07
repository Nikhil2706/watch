import { requireAdmin } from "@/lib/admin-auth";
import { addSeriesEntry } from "@/lib/scraping/film-series";
import { matchTitle } from "@/lib/scraping/match";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * POST /api/admin/library/film-series/{id}/entries — { title, year?, imdb_id? }
 *
 * Adds one film to a franchise, at the end.
 *
 * The title is matched server-side exactly as the Wikipedia ingest matches its
 * own entries, and matchTitle() finding nothing is a real state rather than an
 * error: "declared but not in the library yet" is the whole point of the
 * release-schedule feature these entries feed, and the next library scan
 * re-resolves it.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const { id } = await params;

  let body: { title?: string; year?: number; imdb_id?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "bad json" }, { status: 400, headers: NO_STORE });
  }

  const title = (body.title ?? "").trim();
  if (!title) {
    return Response.json({ error: "invalid_request", message: "A title is required." }, { status: 400, headers: NO_STORE });
  }

  const year = Number.isFinite(Number(body.year)) && body.year ? Number(body.year) : null;

  try {
    const imdbId = body.imdb_id ?? (await matchTitle(title, year)).imdbId;
    const entry = addSeriesEntry({ seriesId: id, title, year, imdbId });
    return Response.json({ ok: true, entry, matched: Boolean(imdbId) }, { status: 201, headers: NO_STORE });
  } catch (error) {
    console.error("[film-series/entries] add failed:", error);
    return Response.json({ error: "internal_error", message: "Could not add the film." }, { status: 500, headers: NO_STORE });
  }
}
