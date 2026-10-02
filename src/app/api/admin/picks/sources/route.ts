import { requireAdmin } from "@/lib/admin-auth";
import { listPickSources, writeupPassagesForFilm } from "@/lib/pick-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * GET /api/admin/picks/sources?q=         lists a pick can be started from
 * GET /api/admin/picks/sources?imdb_id=   scraped passages for one film's writeup
 */
export async function GET(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const url = new URL(request.url);
  const imdbId = url.searchParams.get("imdb_id");
  if (imdbId) {
    return Response.json({ passages: writeupPassagesForFilm(imdbId) }, { headers: NO_STORE });
  }
  return Response.json({ sources: listPickSources(url.searchParams.get("q") ?? "") }, { headers: NO_STORE });
}
