import { requireAdmin } from "@/lib/admin-auth";
import { getDb } from "@/lib/db";
import { createScrapeJob, getScrapeJob, markScrapeJobDone, markScrapeJobFailed } from "@/lib/scraping/jobs";
import { runRingerTvScrape } from "@/lib/scraping/ringer-tv";
import { optionalInt, readJsonBody, ValidationError } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

declare global {
  // eslint-disable-next-line no-var
  var __jellyfinGateRingerTvJob: string | undefined;
}

/**
 * POST /api/admin/accolades/run-ringer-tv   { limit? }
 * GET  /api/admin/accolades/run-ringer-tv   the running job, and what is stored
 *
 * The Ringer's TV writing (ringer-tv.ts). Like run-ringer-lists this answers
 * at once and works in the background: the first run opens every article
 * under /tv/, close to three thousand pages at a polite pace, about an hour.
 * The job row carries the progress: found_count is lists found so far,
 * matched_count the articles and list entries linked to a library show.
 *
 * Safe to run again at any time: an article is fetched once, ever. `limit`
 * caps the pages opened in one run (default: all that remain).
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

  const running = globalThis.__jellyfinGateRingerTvJob;
  if (running) {
    return Response.json(
      { error: "already_running", message: "A Ringer TV run is already going.", job: getScrapeJob(running) },
      { status: 409, headers: NO_STORE },
    );
  }

  const job = createScrapeJob("the-ringer-tv");
  globalThis.__jellyfinGateRingerTvJob = job.id;

  const update = getDb().prepare("UPDATE scrape_jobs SET progress = ?, found_count = ?, matched_count = ? WHERE id = ?");

  void runRingerTvScrape(limit, ({ read, lists, matched }) => {
    // Never 100 from here: only markScrapeJobDone says the run is over.
    const percent = limit < 1e9 ? Math.min(99, Math.floor((read / limit) * 100)) : 0;
    update.run(percent, lists, matched, job.id);
  })
    .then((result) => {
      markScrapeJobDone(job.id, result.lists, result.matchedArticles + result.matchedEntries);
      console.log("[admin/accolades/run-ringer-tv] done:", JSON.stringify(result));
    })
    .catch((error) => {
      markScrapeJobFailed(job.id, error instanceof Error ? error.message : "Unknown error");
      console.error("[admin/accolades/run-ringer-tv] failed:", error);
    })
    .finally(() => {
      globalThis.__jellyfinGateRingerTvJob = undefined;
    });

  return Response.json({ ok: true, started: true, jobId: job.id }, { status: 202, headers: NO_STORE });
}

export async function GET(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const running = globalThis.__jellyfinGateRingerTvJob;
  const count = (sql: string) => (getDb().prepare(sql).get() as { n: number } | undefined)?.n ?? 0;

  return Response.json(
    {
      running: !!running,
      job: running ? getScrapeJob(running) : null,
      articlesStored: count("SELECT COUNT(*) AS n FROM scraped_articles WHERE source_id = 'the-ringer-tv' AND article_type = 'review'"),
      listsStored: count("SELECT COUNT(*) AS n FROM scraped_articles WHERE source_id = 'the-ringer-tv' AND article_type = 'accolade'"),
      linkedToLibrary: count(
        `SELECT COUNT(*) AS n FROM article_film_links l JOIN scraped_articles a ON a.id = l.article_id
          WHERE a.source_id = 'the-ringer-tv' AND l.imdb_id IS NOT NULL`,
      ),
    },
    { headers: NO_STORE },
  );
}
