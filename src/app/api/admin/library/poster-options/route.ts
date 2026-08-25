import { requireAdmin } from "@/lib/admin-auth";
import { getFullItem } from "@/lib/jellyfin";
import { findTmdbMovieByImdbId, getMoviePosters, isTmdbConfigured } from "@/lib/tmdb";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * GET /api/admin/library/poster-options?itemId=...
 *
 * TMDB's available posters for a title, for Library Review's "Change
 * poster" panel — a curator picking a different one than whatever
 * Jellyfin's scan settled on. Read-only; nothing is applied until
 * set-poster is called separately with a chosen URL.
 */
export async function GET(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  if (!isTmdbConfigured()) {
    return Response.json(
      { error: "not_configured", message: "TMDB is not configured." },
      { status: 503, headers: NO_STORE },
    );
  }

  const itemId = new URL(request.url).searchParams.get("itemId");
  if (!itemId) {
    return Response.json(
      { error: "invalid_request", message: "itemId is required." },
      { status: 400, headers: NO_STORE },
    );
  }

  try {
    const item = await getFullItem(itemId);
    const providerIds = item.ProviderIds as Record<string, string> | undefined;
    const imdbId = providerIds?.Imdb;
    if (!imdbId) {
      return Response.json(
        { error: "no_imdb_id", message: "This title has no IMDb id to look up." },
        { status: 400, headers: NO_STORE },
      );
    }

    const tmdbId = await findTmdbMovieByImdbId(imdbId);
    if (!tmdbId) {
      return Response.json({ posters: [] }, { headers: NO_STORE });
    }

    const posters = await getMoviePosters(tmdbId);
    return Response.json({ posters }, { headers: NO_STORE });
  } catch (error) {
    console.error("[admin/library/poster-options] failed:", error);
    return Response.json(
      { error: "internal_error", message: "Could not load poster options." },
      { status: 500, headers: NO_STORE },
    );
  }
}
