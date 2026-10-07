import { requireAdmin } from "@/lib/admin-auth";
import { remoteSearchMovie, type RemoteSearchResult } from "@/lib/jellyfin";
import { optionalInt, optionalString, parseProviderLink, readJsonBody, ValidationError } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

const IDENTIFY_ATTEMPTS = 3;

function hasTmdb(candidates: RemoteSearchResult[]): boolean {
  return candidates.some((c) => c.SearchProviderName === "TheMovieDb" || !!c.ProviderIds?.Tmdb);
}

/**
 * POST /api/admin/library/identify
 * Body: { itemId, name, year?, providerLink? } -> { candidates: RemoteSearchResult[] }
 *
 * Same lookup Jellyfin's own "Identify" screen runs. Two ways in: a
 * corrected title/year for a fuzzy search, or a pasted IMDb/TMDB link/id for
 * an exact one — useful precisely when the fuzzy search can't find the right
 * title at all (an oddly-parsed folder name) but the admin already knows
 * which page it is.
 */
export async function POST(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  try {
    const body = await readJsonBody(request);
    const itemId = optionalString(body, "itemId");
    const name = optionalString(body, "name");
    const year = optionalInt(body, "year");
    const providerLink = optionalString(body, "providerLink");
    if (!itemId || !name) {
      throw new ValidationError("itemId and name are required.");
    }

    const parsed = parseProviderLink(providerLink);
    const providerIds =
      parsed.imdb || parsed.tmdb
        ? { Imdb: parsed.imdb, Tmdb: parsed.tmdb }
        : undefined;
    if (providerLink && !providerIds) {
      throw new ValidationError("Couldn't find an IMDb or TMDB id in that link.");
    }

    /*
     * Jellyfin asks every provider once and returns whatever came back. From
     * this network the connection to TheMovieDb is cut more often than not
     * (measured at two failures in three), and a search that lost it returns
     * OMDb's candidates alone — no poster, no TMDB id — which looks like a
     * film TheMovieDb does not have. A failed attempt comes back in well
     * under a second, so it is asked again, up to three times, until
     * TheMovieDb is among the answers.
     */
    let candidates = await remoteSearchMovie(itemId, name, year, providerIds);
    for (let attempt = 1; attempt < IDENTIFY_ATTEMPTS && !hasTmdb(candidates); attempt++) {
      const again = await remoteSearchMovie(itemId, name, year, providerIds).catch(() => null);
      if (again && (hasTmdb(again) || again.length > candidates.length)) candidates = again;
    }
    return Response.json({ candidates }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof ValidationError) {
      return Response.json(
        { error: "invalid_request", message: error.message },
        { status: 400, headers: NO_STORE },
      );
    }
    console.error("[admin/library/identify] failed:", error);
    return Response.json(
      { error: "internal_error", message: "Search failed." },
      { status: 500, headers: NO_STORE },
    );
  }
}
