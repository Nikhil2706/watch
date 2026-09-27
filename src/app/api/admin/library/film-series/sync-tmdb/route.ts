import { requireAdmin } from "@/lib/admin-auth";
import { syncTmdbFranchises } from "@/lib/scraping/film-series";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * POST /api/admin/library/film-series/sync-tmdb   { budget?: number }
 *   Rebuilds TMDB franchises from the films the library holds. Collections
 *   are cached, so a repeat costs nothing; the budget caps fresh fetches per
 *   call (default 60) on this host's unreliable link, and `done: false` says
 *   to call again.
 */
export async function POST(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const body = (await request.json().catch(() => ({}))) as { budget?: unknown };
  const budget =
    typeof body.budget === "number" && Number.isFinite(body.budget) ? Math.max(1, Math.min(300, body.budget)) : 60;
  try {
    const result = await syncTmdbFranchises(budget);
    return Response.json({ ok: true, ...result }, { headers: NO_STORE });
  } catch (error) {
    console.error("[admin/library/film-series/sync-tmdb] failed:", error);
    return Response.json(
      { error: "internal_error", message: "The TMDB franchise sync failed." },
      { status: 500, headers: NO_STORE },
    );
  }
}
