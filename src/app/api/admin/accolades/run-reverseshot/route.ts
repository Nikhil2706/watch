import { requireAdmin } from "@/lib/admin-auth";
import { optionalInt, readJsonBody, ValidationError } from "@/lib/validation";
import { runReverseShotScrape } from "@/lib/scraping/reverseshot";
import { createScrapeJob, markScrapeJobDone, markScrapeJobFailed } from "@/lib/scraping/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * POST /api/admin/accolades/run-reverseshot
 *   { limit? } — defaults to 10. Kept deliberately small; see
 *   discoverReverseShotReviewUrls's own comment — this is a first test run
 *   against a site vetted for ToS but never actually scraped before.
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

  const job = createScrapeJob("reverseshot");

  try {
    const result = await runReverseShotScrape(limit);
    markScrapeJobDone(job.id, result.reviewsProcessed, result.matchedCount);
    return Response.json({ ok: true, jobId: job.id, ...result }, { headers: NO_STORE });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    markScrapeJobFailed(job.id, message);
    console.error("[admin/accolades/run-reverseshot] failed:", error);
    return Response.json(
      { error: "internal_error", message: "The Reverse Shot run failed." },
      { status: 500, headers: NO_STORE },
    );
  }
}
