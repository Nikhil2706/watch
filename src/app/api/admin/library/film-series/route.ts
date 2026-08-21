import { requireAdmin } from "@/lib/admin-auth";
import { listAllSeries } from "@/lib/scraping/film-series";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** GET /api/admin/library/film-series — every scraped series, for the curator dashboard's own listing (a new one, per the scheduled-rollout feature — see film-series.ts's own comment on why nothing already listed these). */
export async function GET(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  return Response.json({ series: listAllSeries() }, { headers: NO_STORE });
}
