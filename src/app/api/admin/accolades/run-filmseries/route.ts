import { requireAdmin } from "@/lib/admin-auth";
import { runFilmSeriesIngest } from "@/lib/scraping/film-series";
import { createScrapeJob, markScrapeJobDone, markScrapeJobFailed } from "@/lib/scraping/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * POST /api/admin/accolades/run-filmseries
 *   No body — walks the whole Wikipedia meta-index every run (see
 *   film-series.ts), there is no `limit` knob like the article scrapers
 *   have. Stays open until the full pass across all eleven bucket pages
 *   finishes, same as the other run-* routes.
 */
export async function POST(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const job = createScrapeJob("filmseries");

  try {
    const result = await runFilmSeriesIngest();
    markScrapeJobDone(job.id, result.entriesProcessed, result.matchedCount);
    return Response.json({ ok: true, jobId: job.id, ...result }, { headers: NO_STORE });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    markScrapeJobFailed(job.id, message);
    console.error("[admin/accolades/run-filmseries] failed:", error);
    return Response.json({ error: "internal_error", message: "The film-series ingest failed." }, { status: 500, headers: NO_STORE });
  }
}
