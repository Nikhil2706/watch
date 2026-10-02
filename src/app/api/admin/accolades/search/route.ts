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

  const params = new URL(request.url).searchParams;
  const query = params.get("q") ?? "";
  // episodes=1: also offer single episodes of shows, each under its episode
  // key (episode-key.ts) in place of an IMDb id. Asked for by the lists that
  // can hold one — a pick, a built accolade — and not by the Films tab, which
  // manages material that only films have.
  const episodes = params.get("episodes") === "1";
  const results = await searchLibraryForAdmin(query, episodes ? 30 : 10, { episodes });
  return Response.json({ results }, { headers: NO_STORE });
}
