import { requireAdmin } from "@/lib/admin-auth";
import { optionalInt, readJsonBody, ValidationError } from "@/lib/validation";
import { runYearendlistsScrape } from "@/lib/scraping/yearendlists";
import { createScrapeJob, markScrapeJobDone, markScrapeJobFailed } from "@/lib/scraping/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * POST /api/admin/accolades/run-yearendlists
 *   { year? } — defaults to the current year.
 *
 * Runs synchronously: discovering + fetching a year's movie lists is a
 * couple dozen politely-spaced requests, on the order of a minute, not
 * something this single-user app needs a background worker for.
 */
export async function POST(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  let year: number;
  try {
    const body = await readJsonBody(request);
    year = optionalInt(body, "year") ?? new Date().getFullYear();
  } catch (error) {
    if (error instanceof ValidationError) {
      return Response.json({ error: "invalid_request", message: error.message }, { status: 400, headers: NO_STORE });
    }
    year = new Date().getFullYear();
  }

  const job = createScrapeJob("yearendlists");

  try {
    const result = await runYearendlistsScrape(year);
    markScrapeJobDone(job.id, result.entriesFound, result.matchedCount);
    return Response.json({ ok: true, jobId: job.id, year, ...result }, { headers: NO_STORE });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    markScrapeJobFailed(job.id, message);
    console.error("[admin/accolades/run-yearendlists] failed:", error);
    return Response.json(
      { error: "internal_error", message: "The yearendlists.com run failed." },
      { status: 500, headers: NO_STORE },
    );
  }
}
