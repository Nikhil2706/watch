import { requireAdmin } from "@/lib/admin-auth";
import { relinkUnmatchedArticleLinks } from "@/lib/scraping/articles";
import { relinkUnmatchedFilmSeriesEntries } from "@/lib/scraping/film-series";
import { invalidateLibraryIndex } from "@/lib/scraping/match";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * POST /api/admin/accolades/relink
 *
 * Holds every stored list and review mention against the library again, with
 * the matching rules as they are now. A library scan does the same in
 * passing; this is for after the rules themselves change, when the mentions
 * already stored are the ones that need correcting. Returns how many changed.
 */
export async function POST(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;
  try {
    invalidateLibraryIndex();
    const mentions = await relinkUnmatchedArticleLinks();
    const seriesEntries = await relinkUnmatchedFilmSeriesEntries();
    return Response.json({ mentions, seriesEntries }, { headers: NO_STORE });
  } catch (error) {
    console.error("[admin/accolades/relink] failed:", error);
    return Response.json({ error: "internal_error", message: "Could not relink." }, { status: 500, headers: NO_STORE });
  }
}
