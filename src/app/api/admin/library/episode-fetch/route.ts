import { requireAdmin } from "@/lib/admin-auth";
import { applyOmdbEpisodeMetadata, clearItemBackdrop, setItemImage } from "@/lib/jellyfin";
import { getGroupSeriesId, markMetadataConfirmed } from "@/lib/library-curation";
import { fetchOmdbEpisode } from "@/lib/omdb-episodes";
import { optionalInt, optionalString, readJsonBody, ValidationError } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * POST /api/admin/library/episode-fetch
 * Body: { itemId, groupId, season, episode, path? }
 *
 * Looks up the real episode on OMDb using the group's saved series IMDb id
 * plus the season/episode number already parsed from the filename, then
 * applies the title, overview, cast, genres, rating and poster to this
 * specific file's Jellyfin item — the fix for a file that was individually
 * mis-matched as its own movie (e.g. "The Curse" S01E09 tagged as
 * "Reverse the Curse"). Once these fields exist on the item, its own
 * existing detail page renders them the same way it would for a movie.
 */
export async function POST(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  try {
    const body = await readJsonBody(request);
    const itemId = optionalString(body, "itemId");
    const groupId = optionalString(body, "groupId");
    const path = optionalString(body, "path");
    const season = optionalInt(body, "season");
    const episode = optionalInt(body, "episode");
    if (!itemId || !groupId || season === undefined || episode === undefined) {
      throw new ValidationError("itemId, groupId, season and episode are required.");
    }

    const seriesImdbId = getGroupSeriesId(groupId);
    if (!seriesImdbId) {
      throw new ValidationError("Set the group's series IMDb link first.");
    }

    const found = await fetchOmdbEpisode(seriesImdbId, season, episode);
    if (!found) {
      return Response.json(
        { error: "not_found", message: `OMDb has nothing for S${season}E${episode} of that series.` },
        { status: 404, headers: NO_STORE },
      );
    }

    await applyOmdbEpisodeMetadata(itemId, {
      name: found.name,
      overview: found.overview,
      genres: found.genres,
      actors: found.actors,
      director: found.director,
      writer: found.writer,
      imdbRating: found.imdbRating,
      imdbId: found.imdbId,
    });
    if (path) markMetadataConfirmed(path);

    let posterSet = false;
    if (found.posterUrl) {
      try {
        await setItemImage(itemId, found.posterUrl);
        posterSet = true;
        // The item's Backdrop tag, if any, is still whatever the original
        // wrong match left behind — clear it so the item's own detail page
        // falls back to the (now correct) Primary poster instead.
        await clearItemBackdrop(itemId);
      } catch (error) {
        // Text metadata already saved — a poster failure shouldn't undo that.
        console.warn(`[admin/library/episode-fetch] poster set failed for ${itemId}:`, error);
      }
    }

    return Response.json(
      { applied: true, name: found.name, overview: found.overview, posterSet },
      { headers: NO_STORE },
    );
  } catch (error) {
    if (error instanceof ValidationError) {
      return Response.json(
        { error: "invalid_request", message: error.message },
        { status: 400, headers: NO_STORE },
      );
    }
    console.error("[admin/library/episode-fetch] failed:", error);
    return Response.json(
      { error: "internal_error", message: "Could not fetch that episode." },
      { status: 500, headers: NO_STORE },
    );
  }
}
