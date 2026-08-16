import { requireAdmin } from "@/lib/admin-auth";
import { remoteSearchMovie } from "@/lib/jellyfin";
import { optionalInt, optionalString, parseProviderLink, readJsonBody, ValidationError } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

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

    const candidates = await remoteSearchMovie(itemId, name, year, providerIds);
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
