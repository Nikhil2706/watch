import { requireAdmin } from "@/lib/admin-auth";
import { createScrapeJob, markScrapeJobDone, markScrapeJobFailed } from "@/lib/scraping/jobs";
import { runWikipediaListIngest } from "@/lib/scraping/wikipedia-lists";
import { optionalString, readJsonBody, ValidationError } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * POST /api/admin/accolades/run-wikipedia-list
 *   { page_title, kind: "ranked" | "winners", rank_column_hint?, award_label?, winners_only? }
 *
 * One-shot ingest of a Wikipedia LIST page (AFI's "100 Years..." lists,
 * or a festival's year-by-year winners page) — distinct from the per-film
 * Wikipedia adapter and its backfill loop. See wikipedia-lists.ts for the
 * parsing; this route just triggers a single run against one named page.
 *
 * winners_only matters only for kind: "winners" — true (the default) for a
 * page that lists ONLY winners (Palme d'Or, Golden Lion: every row counts);
 * false for a page that lists nominees alongside the winner each year
 * (Academy Award for Best Picture: only the bold/year-paired row counts) —
 * get this wrong and every nominee gets stored as a "win".
 */
export async function POST(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  let pageTitle: string;
  let kind: "ranked" | "winners";
  let rankColumnHint: string | undefined;
  let awardLabel: string | undefined;
  let winnersOnly: boolean | undefined;

  try {
    const body = await readJsonBody(request);
    pageTitle = optionalString(body, "page_title") ?? "";
    if (!pageTitle) throw new ValidationError("page_title is required.");
    const kindRaw = optionalString(body, "kind");
    if (kindRaw !== "ranked" && kindRaw !== "winners") {
      throw new ValidationError('kind must be "ranked" or "winners".');
    }
    kind = kindRaw;
    rankColumnHint = optionalString(body, "rank_column_hint");
    awardLabel = optionalString(body, "award_label");
    if (body.winners_only !== undefined) {
      if (typeof body.winners_only !== "boolean") throw new ValidationError("winners_only must be a boolean.");
      winnersOnly = body.winners_only;
    }
  } catch (error) {
    if (error instanceof ValidationError) {
      return Response.json({ error: "invalid_request", message: error.message }, { status: 400, headers: NO_STORE });
    }
    return Response.json({ error: "invalid_request", message: "Could not read request body." }, { status: 400, headers: NO_STORE });
  }

  const job = createScrapeJob("wikipedia");

  try {
    const result = await runWikipediaListIngest({ pageTitle, kind, rankColumnHint, awardLabel, winnersOnly });
    if (!result) {
      markScrapeJobFailed(job.id, "Page not found.");
      return Response.json({ error: "not_found", message: `No Wikipedia page found for "${pageTitle}".` }, { status: 404, headers: NO_STORE });
    }
    markScrapeJobDone(job.id, result.entriesFound, result.matchedCount);
    return Response.json({ ok: true, jobId: job.id, ...result }, { headers: NO_STORE });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    markScrapeJobFailed(job.id, message);
    console.error("[admin/accolades/run-wikipedia-list] failed:", error);
    return Response.json({ error: "internal_error", message: "The Wikipedia list run failed." }, { status: 500, headers: NO_STORE });
  }
}
