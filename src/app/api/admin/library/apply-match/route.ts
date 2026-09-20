import { requireAdmin } from "@/lib/admin-auth";
import { forgetAdminMovie } from "@/lib/admin-library-cache";
import {
  applyRemoteSearchMatch,
  clearItemBackdrop,
  getAdminMovie,
  type RemoteSearchResult,
} from "@/lib/jellyfin";
import { markMetadataConfirmed } from "@/lib/library-curation";
import { forgetTmdbForPath } from "@/lib/tmdb-people";
import { putLink } from "@/lib/tmdb-store";
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

    // The stale TMDB link can only be found by file path, and a caller that
    // posts a bare { itemId, candidate } does not send one — which used to mean
    // the title was corrected while the previous film's crew stayed attached.
    // Look it up rather than depend on the caller. A path does not change when
    // a film is re-identified, so reading it first is safe.
    const filePath =
      path ?? (await getAdminMovie(itemId, { withMediaSources: false }).catch(() => null))?.Path ?? null;

    await applyRemoteSearchMatch(itemId, candidate as RemoteSearchResult);
    // Forget it rather than re-read it. Jellyfin applies a remote match
    // asynchronously, so re-reading now returns the OLD row and caches it as
    // the new truth — which is how a corrected film kept getting re-linked to
    // the previous film's TMDB id until the process was restarted.
    forgetAdminMovie(itemId);

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

    // Confirming stays tied to a caller that named the file, as before; this
    // change is only about never leaving a stale TMDB link behind.
    if (path) markMetadataConfirmed(path);
    if (filePath) {
      // The TMDB link still points at the film this one was mistaken for, and
      // so does every credit built from it. Drop both.
      forgetTmdbForPath(filePath);

      /*
       * Then write the new link straight from the candidate, when it carries a
       * TMDB id of its own.
       *
       * Leaving the backfill to re-resolve it is what made this fragile: the
       * backfill reads provider ids for the whole library at once, and the
       * seconds just after an apply are exactly when Jellyfin has not finished
       * writing the new ones. The admin, meanwhile, picked this candidate by
       * id — there is a correct answer in hand right here, and no reason to
       * throw it away and go back for a racier copy of it.
       *
       * Candidates from providers with no stable id of their own (OMDb) carry
       * only an IMDb id; those still fall through to the backfill, which
       * resolves them from a per-item read.
       */
      const candidateTmdbId = Number(
        (candidate as RemoteSearchResult).ProviderIds?.Tmdb ?? NaN,
      );
      if (Number.isFinite(candidateTmdbId) && candidateTmdbId > 0) {
        putLink({
          subjectType: "path",
          subjectId: filePath,
          tmdbKind: "movie",
          tmdbId: candidateTmdbId,
          season: null,
          episode: null,
          resolvedBy: "apply-match",
        });
      }
    }
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
