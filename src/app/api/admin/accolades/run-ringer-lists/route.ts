import { requireAdmin } from "@/lib/admin-auth";
import { getDb } from "@/lib/db";
import { createScrapeJob, getScrapeJob, markScrapeJobDone, markScrapeJobFailed } from "@/lib/scraping/jobs";
import { runRingerListScrape } from "@/lib/scraping/ringer-lists";
import { optionalInt, readJsonBody, ValidationError } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

declare global {
  // eslint-disable-next-line no-var
  var __jellyfinGateRingerListJob: string | undefined;
}

/**
 * POST /api/admin/accolades/run-ringer-lists   { limit? }
 * GET  /api/admin/accolades/run-ringer-lists   the running (or last) job
 *
 * Unlike the other run-* routes this answers at once and works in the
 * background. Finding the lists means opening every non-review article under
 * /movies/ — a couple of thousand pages at a polite pace, well over an hour
 * the first time — and no request should be held open that long. The job row
 * carries the progress: found_count is lists found so far, matched_count the
 * entries matched to the library, progress the share of this run's pages
 * read.
 *
 * Safe to run again at any time: a page is fetched once, ever. `limit` caps
 * the pages opened in one run (default: all that remain).
 */
export async function POST(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  let limit: number;
  try {
    const body = await readJsonBody(request);
    limit = optionalInt(body, "limit") ?? Number.MAX_SAFE_INTEGER;
    if (limit < 1) throw new ValidationError("limit must be at least 1.");
  } catch (error) {
    if (error instanceof ValidationError) {
      return Response.json({ error: "invalid_request", message: error.message }, { status: 400, headers: NO_STORE });
    }
    throw error;
  }

  const running = globalThis.__jellyfinGateRingerListJob;
  if (running) {
    return Response.json(
      { error: "already_running", message: "A Ringer list run is already going.", job: getScrapeJob(running) },
      { status: 409, headers: NO_STORE },
    );
  }

  const job = createScrapeJob("the-ringer");
  globalThis.__jellyfinGateRingerListJob = job.id;

  const update = getDb().prepare(
    "UPDATE scrape_jobs SET progress = ?, found_count = ?, matched_count = ? WHERE id = ?",
  );

  void runRingerListScrape(limit, ({ checked, listsFound, matchedCount }) => {
    // Never 100 from here: only markScrapeJobDone says the run is over.
    const percent = Number.isFinite(limit) && limit < 1e9 ? Math.min(99, Math.floor((checked / limit) * 100)) : 0;
    update.run(percent, listsFound, matchedCount, job.id);
  })
    .then((result) => {
      markScrapeJobDone(job.id, result.listsFound, result.matchedCount);
      console.log("[admin/accolades/run-ringer-lists] done:", JSON.stringify(result));
    })
    .catch((error) => {
      markScrapeJobFailed(job.id, error instanceof Error ? error.message : "Unknown error");
      console.error("[admin/accolades/run-ringer-lists] failed:", error);
    })
    .finally(() => {
      globalThis.__jellyfinGateRingerListJob = undefined;
    });

  return Response.json({ ok: true, started: true, jobId: job.id }, { status: 202, headers: NO_STORE });
}

export async function GET(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const running = globalThis.__jellyfinGateRingerListJob;
  const checked =
    (getDb().prepare("SELECT COUNT(*) AS n FROM scrape_checked_urls WHERE source_id = 'the-ringer'").get() as
      | { n: number }
      | undefined)?.n ?? 0;
  const lists =
    (getDb()
      .prepare("SELECT COUNT(*) AS n FROM scraped_articles WHERE source_id = 'the-ringer' AND article_type = 'accolade'")
      .get() as { n: number } | undefined)?.n ?? 0;

  return Response.json(
    { running: !!running, job: running ? getScrapeJob(running) : null, pagesReadSoFar: checked + lists, listsStored: lists },
    { headers: NO_STORE },
  );
}
