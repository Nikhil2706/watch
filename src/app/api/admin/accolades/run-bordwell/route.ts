import { requireAdmin } from "@/lib/admin-auth";
import { optionalInt, readJsonBody, ValidationError } from "@/lib/validation";
import { runBordwellScrape } from "@/lib/scraping/bordwell";
import { createScrapeJob, markScrapeJobDone, markScrapeJobFailed } from "@/lib/scraping/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * POST /api/admin/accolades/run-bordwell
 *   { limit? } — defaults to 10. First run against a site vetted for
 *   robots.txt/Crawl-delay but never actually scraped before — see
 *   bordwell.ts. That file's REQUEST_DELAY_MS (10s, matching the site's own
 *   declared Crawl-delay) means a large limit takes real wall-clock time;
 *   this request stays open until the whole pass finishes rather than
 *   returning early, same as the other run-* routes.
 */
export async function POST(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  let limit: number;
  try {
    const body = await readJsonBody(request);
    limit = optionalInt(body, "limit") ?? 10;
  } catch (error) {
    if (error instanceof ValidationError) {
      return Response.json({ error: "invalid_request", message: error.message }, { status: 400, headers: NO_STORE });
    }
    limit = 10;
  }

  const job = createScrapeJob("davidbordwell");

  try {
    const result = await runBordwellScrape(limit);
    markScrapeJobDone(job.id, result.postsProcessed, result.matchedCount);
    return Response.json({ ok: true, jobId: job.id, ...result }, { headers: NO_STORE });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    markScrapeJobFailed(job.id, message);
    console.error("[admin/accolades/run-bordwell] failed:", error);
    return Response.json({ error: "internal_error", message: "The David Bordwell run failed." }, { status: 500, headers: NO_STORE });
  }
}
