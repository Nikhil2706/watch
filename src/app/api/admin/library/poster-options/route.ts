import { requireAdmin } from "@/lib/admin-auth";
import { getFullItem } from "@/lib/jellyfin";
import { artworkForTmdbId } from "@/lib/tmdb-artwork";
import { findTmdbMovieByImdbId, getMoviePosters, isTmdbConfigured } from "@/lib/tmdb";
import { getLink } from "@/lib/tmdb-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * GET /api/admin/library/poster-options?itemId=...
 *
 * Every artwork TMDB has for a title — posters, backdrops and logos — for the
 * console's picker. Read-only; nothing is applied until set-poster is called
 * with a chosen URL.
 *
 * Served from the local TMDB store. This used to make two live calls on every
 * open (resolve the IMDb id, then fetch images), which was the only option
 * before the store existed. The store now holds around twenty posters per film
 * already, and on a connection that drops one request in thirty, going to the
 * network for them meant a film with twenty posters could report having none.
 *
 * The live path is kept as a fallback for a film not yet in the store.
 */
export async function GET(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const itemId = new URL(request.url).searchParams.get("itemId");
  if (!itemId) {
    return Response.json(
      { error: "invalid_request", message: "itemId is required." },
      { status: 400, headers: NO_STORE },
    );
  }

  try {
    const item = await getFullItem(itemId);
    const path = (item as { Path?: string }).Path;

    // Cheapest route first: the link says which TMDB film this is, and the
    // store already holds its images.
    const link = path ? getLink("path", path) : null;
    if (link && link.tmdbKind === "movie" && link.tmdbId > 0) {
      const art = artworkForTmdbId(link.tmdbId);
      if (art.cached) {
        return Response.json(
          { source: "cache", posters: art.poster, backdrops: art.backdrop, logos: art.logo },
          { headers: NO_STORE },
        );
      }
    }

    // Not in the store yet — fall back to asking TMDB, as this route always did.
    if (!isTmdbConfigured()) {
      return Response.json(
        { error: "not_configured", message: "TMDB is not configured." },
        { status: 503, headers: NO_STORE },
      );
    }

    const imdbId = (item.ProviderIds as Record<string, string> | undefined)?.Imdb;
    if (!imdbId) {
      return Response.json(
        { error: "no_imdb_id", message: "This title has no IMDb id to look up." },
        { status: 400, headers: NO_STORE },
      );
    }

    const tmdbId = await findTmdbMovieByImdbId(imdbId);
    if (!tmdbId) {
      return Response.json(
        { error: "not_found", message: "TMDB does not recognise this title." },
        { status: 404, headers: NO_STORE },
      );
    }

    const posters = await getMoviePosters(tmdbId);
    return Response.json(
      { source: "live", posters, backdrops: [], logos: [] },
      { headers: NO_STORE },
    );
  } catch (error) {
    console.error("[poster-options] failed:", error);
    return Response.json(
      { error: "internal_error", message: "Could not load artwork." },
      { status: 500, headers: NO_STORE },
    );
  }
}
