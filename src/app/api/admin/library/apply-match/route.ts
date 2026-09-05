import { requireAdmin } from "@/lib/admin-auth";
import { invalidateAdminMovies } from "@/lib/admin-library-cache";
import { applyRemoteSearchMatch, clearItemBackdrop, type RemoteSearchResult } from "@/lib/jellyfin";
import { markMetadataConfirmed } from "@/lib/library-curation";
import { optionalString, readJsonBody, ValidationError } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * POST /api/admin/library/apply-match
 * Body: { itemId, candidate, path? } -> applies one of /identify's results.
 *
 * `candidate` is passed back exactly as /identify returned it — Jellyfin's
 * Apply endpoint wants the whole RemoteSearchResult object, not just an id,
 * since some providers (OMDb here) don't carry a stable id to re-look-up by.
 *
 * `path`, when the caller already has it, marks the file as admin-confirmed
 * — see library_confirmed_metadata in schema.ts for why.
 */
export async function POST(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  try {
    const body = await readJsonBody(request);
    const itemId = optionalString(body, "itemId");
    const path = optionalString(body, "path");
    const candidate = body.candidate;
    if (!itemId || typeof candidate !== "object" || candidate === null) {
      throw new ValidationError("itemId and candidate are required.");
    }

    await applyRemoteSearchMatch(itemId, candidate as RemoteSearchResult);
    // The title just changed; the cached listing still has the wrong one.
    invalidateAdminMovies();

    /*
     * Drop any backdrop the previous (wrong) match left behind.
     *
     * media.ts's backdropUrl() reads BackdropImageTags before it ever looks at
     * the Primary poster, so a stale backdrop keeps the wrong film's still on
     * the detail page even after everything else is corrected — the exact
     * problem episode-fetch already clears backdrops for. Whether Jellyfin's
     * own re-match also replaces images here is untested (see the note about
     * replaceAllImages); this makes the answer not matter. Best-effort:
     * clearItemBackdrop() treats a 404 as "nothing to delete", and a
     * corrected title is worth keeping even if the artwork call fails.
     */
    try {
      await clearItemBackdrop(itemId);
    } catch (error) {
      console.warn(`[admin/library/apply-match] backdrop clear failed for ${itemId}:`, error);
    }

    if (path) markMetadataConfirmed(path);
    return Response.json({ applied: true }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof ValidationError) {
      return Response.json(
        { error: "invalid_request", message: error.message },
        { status: 400, headers: NO_STORE },
      );
    }
    console.error("[admin/library/apply-match] failed:", error);
    return Response.json(
      { error: "internal_error", message: "Could not apply that match." },
      { status: 500, headers: NO_STORE },
    );
  }
}
