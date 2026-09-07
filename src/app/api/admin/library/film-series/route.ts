import { requireAdmin } from "@/lib/admin-auth";
import { createManualSeries, listAllSeries } from "@/lib/scraping/film-series";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** GET /api/admin/library/film-series — every scraped series, for the curator dashboard's own listing (a new one, per the scheduled-rollout feature — see film-series.ts's own comment on why nothing already listed these). */
export async function GET(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  return Response.json({ series: listAllSeries() }, { headers: NO_STORE });
}

/**
 * POST /api/admin/library/film-series — { name }
 *
 * Create a franchise by hand. The Wikipedia ingest covers what its bucket
 * index covers and is silent about everything else; [REC] is four films, in
 * the library, and on none of those pages, so without this there was no route
 * by which it could ever appear on the Franchises tab.
 */
export async function POST(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  let body: { name?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "bad json" }, { status: 400, headers: NO_STORE });
  }

  const name = (body.name ?? "").trim();
  if (!name) {
    return Response.json({ error: "invalid_request", message: "A name is required." }, { status: 400, headers: NO_STORE });
  }

  try {
    const series = createManualSeries(name);
    return Response.json({ ok: true, series }, { status: 201, headers: NO_STORE });
  } catch (error) {
    console.error("[film-series] create failed:", error);
    return Response.json({ error: "internal_error", message: "Could not create the franchise." }, { status: 500, headers: NO_STORE });
  }
}
