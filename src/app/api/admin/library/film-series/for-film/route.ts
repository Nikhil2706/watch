import { requireAdmin } from "@/lib/admin-auth";
import { getAdminMovies } from "@/lib/admin-library-cache";
import { buildFranchiseFromTmdb, seriesForFilm } from "@/lib/scraping/film-series";
import { findTmdbMovieByImdbId } from "@/lib/tmdb";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * GET /api/admin/library/film-series/for-film?imdbId=tt…
 *
 * Which franchises this one film is in — for the film's own panel in the
 * workspace, so membership is visible and editable where you are already
 * looking at the film, not only from the Franchises tab.
 */
export async function GET(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const imdbId = new URL(request.url).searchParams.get("imdbId");
  if (!imdbId) {
    return Response.json({ error: "invalid_request", message: "imdbId is required." }, { status: 400, headers: NO_STORE });
  }
  return Response.json({ series: seriesForFilm(imdbId) }, { headers: NO_STORE });
}

/**
 * POST /api/admin/library/film-series/for-film — { itemId }
 *
 * Ask TMDB which collection this film belongs to and build the franchise from
 * it. This is the route that exists because Wikipedia's bucket index does not
 * list every franchise — [REC] among them — and OMDb carries no collection
 * field at all to fall back on.
 */
export async function POST(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  let body: { itemId?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "bad json" }, { status: 400, headers: NO_STORE });
  }
  if (!body.itemId) {
    return Response.json({ error: "invalid_request", message: "itemId is required." }, { status: 400, headers: NO_STORE });
  }

  const movies = await getAdminMovies({ withMediaSources: false }).catch(() => []);
  const movie = movies.find((m) => m.Id === body.itemId);
  if (!movie) {
    return Response.json({ error: "not_found", message: "No such item." }, { status: 404, headers: NO_STORE });
  }

  // TMDB's own id where Jellyfin already has it; otherwise resolve through the
  // IMDb id, which is the key everything else here is stored against.
  let tmdbId = Number(movie.ProviderIds?.Tmdb);
  if (!Number.isFinite(tmdbId) || tmdbId <= 0) {
    const imdb = movie.ProviderIds?.Imdb;
    if (!imdb) {
      return Response.json(
        { ok: false, reason: "This film has no TMDB or IMDb id yet — identify it first." },
        { headers: NO_STORE },
      );
    }
    const resolved = await findTmdbMovieByImdbId(imdb).catch(() => null);
    if (!resolved) {
      return Response.json({ ok: false, reason: "TMDB does not recognise this film." }, { headers: NO_STORE });
    }
    tmdbId = resolved;
  }

  try {
    const result = await buildFranchiseFromTmdb(tmdbId);
    return Response.json({ ok: !result.reason, ...result }, { headers: NO_STORE });
  } catch (error) {
    console.error("[film-series/for-film] tmdb build failed:", error);
    return Response.json({ error: "internal_error", message: "Could not reach TMDB." }, { status: 500, headers: NO_STORE });
  }
}
