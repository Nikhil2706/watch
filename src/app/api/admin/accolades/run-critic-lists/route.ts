import { requireAdmin } from "@/lib/admin-auth";
import { getDb } from "@/lib/db";
import { runCriticListScrape, type CriticListSource } from "@/lib/scraping/critic-lists";
import { createScrapeJob, getScrapeJob, markScrapeJobDone, markScrapeJobFailed } from "@/lib/scraping/jobs";
import { optionalString, readJsonBody, ValidationError } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

const SOURCE_IDS: Record<CriticListSource, string> = { reverseshot: "reverseshot", bordwell: "davidbordwell" };

declare global {
  // eslint-disable-next-line no-var
  var __jellyfinGateCriticListJobs: Partial<Record<CriticListSource, string>> | undefined;
}

function running(): Partial<Record<CriticListSource, string>> {
  globalThis.__jellyfinGateCriticListJobs ??= {};
  return globalThis.__jellyfinGateCriticListJobs;
}

function isSource(value: string | undefined): value is CriticListSource {
  return value === "reverseshot" || value === "bordwell";
}

/**
 * POST /api/admin/accolades/run-critic-lists   { source: "reverseshot" | "bordwell", refresh? }
 * GET  /api/admin/accolades/run-critic-lists   what is running, and what is stored
 *
 * Reverse Shot's yearly best-of features and the yearly ten-best posts on
 * David Bordwell's site (critic-lists.ts). Like run-ringer-lists this answers
 * at once and works in the background: both sites ask for ten seconds between
 * requests, and walking an index at that pace takes minutes.
 *
 * Safe to run again at any time: a list already stored is not fetched again.
 */
export async function POST(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  let source: CriticListSource;
  // refresh: read every list again, stored or not — after a change to the parser.
  let refresh = false;
  try {
    const body = await readJsonBody(request);
    const raw = optionalString(body, "source");
    if (!isSource(raw)) throw new ValidationError('source must be "reverseshot" or "bordwell".');
    source = raw;
    refresh = body.refresh === true;
  } catch (error) {
    if (error instanceof ValidationError) {
      return Response.json({ error: "invalid_request", message: error.message }, { status: 400, headers: NO_STORE });
    }
    throw error;
  }

  const jobs = running();
  if (jobs[source]) {
    return Response.json(
      { error: "already_running", message: "That site's lists are already being read.", job: getScrapeJob(jobs[source]!) },
      { status: 409, headers: NO_STORE },
    );
  }

  const job = createScrapeJob(SOURCE_IDS[source]);
  jobs[source] = job.id;

  const update = getDb().prepare("UPDATE scrape_jobs SET found_count = ?, matched_count = ? WHERE id = ?");

  void runCriticListScrape(source, ({ listsFound, matchedCount }) => update.run(listsFound, matchedCount, job.id), { refresh })
    .then((result) => {
      markScrapeJobDone(job.id, result.listsFound, result.matchedCount);
      console.log(`[admin/accolades/run-critic-lists] ${source} done:`, JSON.stringify(result));
    })
    .catch((error) => {
      markScrapeJobFailed(job.id, error instanceof Error ? error.message : "Unknown error");
      console.error(`[admin/accolades/run-critic-lists] ${source} failed:`, error);
    })
    .finally(() => {
      delete jobs[source];
    });

  return Response.json({ ok: true, started: true, jobId: job.id }, { status: 202, headers: NO_STORE });
}

export async function GET(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const jobs = running();
  const stored = (sourceId: string) =>
    (getDb()
      .prepare("SELECT COUNT(*) AS n FROM scraped_articles WHERE source_id = ? AND article_type = 'accolade'")
      .get(sourceId) as { n: number } | undefined)?.n ?? 0;

  return Response.json(
    {
      reverseshot: { running: !!jobs.reverseshot, job: jobs.reverseshot ? getScrapeJob(jobs.reverseshot) : null, listsStored: stored("reverseshot") },
      bordwell: { running: !!jobs.bordwell, job: jobs.bordwell ? getScrapeJob(jobs.bordwell) : null, listsStored: stored("davidbordwell") },
    },
    { headers: NO_STORE },
  );
}
