import { requireAdmin } from "@/lib/admin-auth";
import { runTmdbBackfillTick } from "@/lib/tmdb-backfill";
import { tmdbStoreStats } from "@/lib/tmdb-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** GET /api/admin/tmdb — what is in the store. */
export async function GET(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;
  return Response.json(tmdbStoreStats(), { headers: NO_STORE });
}

/**
 * POST /api/admin/tmdb — run one bounded batch. { budget? }
 *
 * Bounded and repeatable rather than one long run: TMDB has no daily quota to
 * respect, but this host's link to it drops connections often enough that a
 * synchronous pass over the whole library would spend minutes failing. Press it
 * again to continue — the store itself is the cursor.
 */
export async function POST(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  let budget = 40;
  try {
    const body = (await request.json()) as { budget?: number };
    const n = Number(body?.budget);
    if (Number.isFinite(n) && n > 0) budget = Math.min(300, Math.floor(n));
  } catch {
    // No body is fine — the default budget is the point.
  }

  try {
    const result = await runTmdbBackfillTick(budget);
    return Response.json({ ok: true, ...result, stats: tmdbStoreStats() }, { headers: NO_STORE });
  } catch (error) {
    console.error("[tmdb] backfill tick failed:", error);
    return Response.json({ error: "internal_error", message: "The TMDB pass failed." }, { status: 500, headers: NO_STORE });
  }
}
