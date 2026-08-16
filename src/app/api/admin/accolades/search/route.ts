import { requireAdmin } from "@/lib/admin-auth";
import { searchLibraryForAdmin } from "@/lib/scraping/admin-search";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * GET /api/admin/accolades/search?q=...
 *
 * Shared by the Films tab (find a film to manage) and the Builder (search
 * a slot) — both just need {imdbId, name, year}, no images.
 */
export async function GET(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const query = new URL(request.url).searchParams.get("q") ?? "";
  const results = await searchLibraryForAdmin(query, 10);
  return Response.json({ results }, { headers: NO_STORE });
}
