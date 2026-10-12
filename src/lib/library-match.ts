import "server-only";

import { forgetAdminMovie } from "./admin-library-cache";
import { applyRemoteSearchMatch, clearItemBackdrop, getAdminMovie, type RemoteSearchResult } from "./jellyfin";
import { markMetadataConfirmed } from "./library-curation";
import { forgetTmdbForPath } from "./tmdb-people";
import { putLink } from "./tmdb-store";

/**
 * Applies one identify candidate to a library item, with everything that has
 * to follow it. Shared by the console's "Identify" (apply-match route) and by
 * matches made from a file's folders (folder-match.ts), so a film matched
 * either way ends up in the same state.
 *
 * `confirmPath`, when given, marks the file as admin-confirmed — see
 * library_confirmed_metadata in schema.ts for why. A match nobody looked at
 * does not pass one.
 */
export async function applyLibraryMatch(
  itemId: string,
  candidate: RemoteSearchResult,
  options: { confirmPath?: string | null; knownPath?: string | null; resolvedBy?: string } = {},
): Promise<void> {
  // The stale TMDB link can only be found by file path, and a caller that
  // posts a bare { itemId, candidate } does not send one — which used to mean
  // the title was corrected while the previous film's crew stayed attached.
  // Look it up rather than depend on the caller. A path does not change when
  // a film is re-identified, so reading it first is safe.
  const filePath =
    options.confirmPath ??
    options.knownPath ??
    (await getAdminMovie(itemId, { withMediaSources: false }).catch(() => null))?.Path ??
    null;

  await applyRemoteSearchMatch(itemId, candidate);
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
    console.warn(`[library-match] backdrop clear failed for ${itemId}:`, error);
  }

  // Confirming stays tied to a caller that named the file, as before; this
  // is only about never leaving a stale TMDB link behind.
  if (options.confirmPath) markMetadataConfirmed(options.confirmPath);
  if (!filePath) return;

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
  const candidateTmdbId = Number(candidate.ProviderIds?.Tmdb ?? NaN);
  if (Number.isFinite(candidateTmdbId) && candidateTmdbId > 0) {
    putLink({
      subjectType: "path",
      subjectId: filePath,
      tmdbKind: "movie",
      tmdbId: candidateTmdbId,
      season: null,
      episode: null,
      resolvedBy: options.resolvedBy ?? "apply-match",
    });
  }
}
