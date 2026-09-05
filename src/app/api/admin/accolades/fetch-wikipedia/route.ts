import { requireAdmin } from "@/lib/admin-auth";
import { getAdminMovies } from "@/lib/admin-library-cache";
import { optionalString, readJsonBody, ValidationError } from "@/lib/validation";
import { fetchWikipediaForFilm } from "@/lib/scraping/wikipedia";
import { createScrapeJob, markScrapeJobDone, markScrapeJobFailed } from "@/lib/scraping/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * POST /api/admin/accolades/fetch-wikipedia
 *   { imdb_id }
 *
 * Per-film, not a site crawl — Wikipedia film pages are single-subject, so
 * "run Wikipedia" only makes sense pointed at one library film at a time
 * (this is what the Films tab's per-film detail view calls).
 */
export async function POST(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  let imdbId: string;
  try {
    const body = await readJsonBody(request);
    const value = optionalString(body, "imdb_id");
    if (!value) throw new ValidationError("imdb_id is required.");
    imdbId = value;
  } catch (error) {
    if (error instanceof ValidationError) {
      return Response.json({ error: "invalid_request", message: error.message }, { status: 400, headers: NO_STORE });
    }
    return Response.json({ error: "invalid_request", message: "Invalid request." }, { status: 400, headers: NO_STORE });
  }

  const movies = await getAdminMovies({ withMediaSources: false });
  const movie = movies.find((m) => m.ProviderIds?.Imdb === imdbId);
  if (!movie) {
    return Response.json(
      { error: "not_found", message: "No library film with that IMDb id." },
      { status: 404, headers: NO_STORE },
    );
  }

  const job = createScrapeJob("wikipedia", imdbId);

  try {
    const result = await fetchWikipediaForFilm(movie.Name, movie.ProductionYear ?? null, imdbId);
    if (!result.found) {
      markScrapeJobDone(job.id, 0, 0);
      return Response.json({ ok: true, jobId: job.id, found: false }, { headers: NO_STORE });
    }
    markScrapeJobDone(job.id, 1 + (result.accoladeCount ?? 0), 1);
    return Response.json({ ok: true, jobId: job.id, ...result }, { headers: NO_STORE });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    markScrapeJobFailed(job.id, message);
    console.error("[admin/accolades/fetch-wikipedia] failed:", error);
    return Response.json(
      { error: "internal_error", message: "The Wikipedia fetch failed." },
      { status: 500, headers: NO_STORE },
    );
  }
}
