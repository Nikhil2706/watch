import { requireAdmin } from "@/lib/admin-auth";
import {
  getGroupOverview,
  setGroupOverview,
  setGroupKind,
  setGroupSeriesId,
  setGroupSeriesMeta,
  setGroupSeriesPoster,
} from "@/lib/library-curation";
import { fetchOmdbSeries } from "@/lib/omdb-episodes";
import { optionalString, parseProviderLink, readJsonBody, ValidationError } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * POST /api/admin/library/group-series
 * Body: { groupId, providerLink }
 *
 * Sets the real TV series' IMDb id for a group — OMDb keys episode lookups
 * on it, not a TMDB id, so only an IMDb link/id is accepted here even though
 * parseProviderLink also recognises TMDB links.
 *
 * Also pulls the series' own poster (for the group's tile and the
 * collection header — never any one episode's) and, if the admin hasn't
 * already written a custom synopsis, fills it in from OMDb.
 */
export async function POST(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  try {
    const body = await readJsonBody(request);
    const groupId = optionalString(body, "groupId");
    const providerLink = optionalString(body, "providerLink");
    if (!groupId || !providerLink) throw new ValidationError("groupId and providerLink are required.");

    const parsed = parseProviderLink(providerLink);
    if (!parsed.imdb) {
      throw new ValidationError("Couldn't find an IMDb id in that link — OMDb needs the series' IMDb page, not TMDB.");
    }

    setGroupSeriesId(groupId, parsed.imdb);

    const series = await fetchOmdbSeries(parsed.imdb);
    /*
     * Only ever set from OMDb here, never cleared: a curator who has already
     * corrected this group by hand (a long film OMDb calls a mini-series)
     * shouldn't have that undone by someone re-linking the same series.
     */
    if (series?.kind) setGroupKind(groupId, series.kind);
    if (series?.posterUrl) setGroupSeriesPoster(groupId, series.posterUrl);
    if (series?.overview && !getGroupOverview(groupId)) setGroupOverview(groupId, series.overview);
    if (series) {
      setGroupSeriesMeta(groupId, {
        genres: series.genres,
        actors: series.actors,
        director: series.director,
        writer: series.writer,
      });
    }

    return Response.json(
      {
        saved: true,
        imdbId: parsed.imdb,
        seriesName: series?.name ?? null,
        posterFound: Boolean(series?.posterUrl),
        kind: series?.kind ?? null,
      },
      { headers: NO_STORE },
    );
  } catch (error) {
    if (error instanceof ValidationError) {
      return Response.json(
        { error: "invalid_request", message: error.message },
        { status: 400, headers: NO_STORE },
      );
    }
    console.error("[admin/library/group-series] failed:", error);
    return Response.json(
      { error: "internal_error", message: "Could not save the series id." },
      { status: 500, headers: NO_STORE },
    );
  }
}
