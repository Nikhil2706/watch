import { requireAdmin } from "@/lib/admin-auth";
import { invalidateAdminMovies } from "@/lib/admin-library-cache";
import { getDb } from "@/lib/db";
import { env } from "@/lib/env";
import { JellyfinError, refreshLibrary, refreshLibraryFolders } from "@/lib/jellyfin";
import { toLibraryPath } from "@/lib/library-folders";
import { relinkUnmatchedPickItems } from "@/lib/picks";
import { relinkUnmatchedAccoladeEntries, relinkUnmatchedArticleLinks } from "@/lib/scraping/articles";
import { relinkUnmatchedFilmSeriesEntries } from "@/lib/scraping/film-series";
import { invalidateLibraryIndex } from "@/lib/scraping/match";
import { promoteSubtitles } from "@/lib/subtitle-promotion";
import { readJsonBody, ValidationError } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * POST /api/admin/library/scan
 *   { folders?: string[] }
 *
 * With `folders` — where the new files were put, as Jellyfin's path, the
 * Explorer path, or the part under the library — only those are re-read,
 * which takes seconds where the whole library takes minutes. A folder
 * Jellyfin has no item above (a file in the library root) cannot be re-read
 * on its own, and the whole library is scanned instead; the response says
 * which happened.
 *
 * Triggers a Jellyfin library scan. Needed because the `jellyfin` container
 * mounts the library read-only, so Jellyfin never notices a file removed or
 * added on disk until something asks it to rescan. LIBRARY_SCAN=false turns
 * off the worker's periodic auto-scan, so this is otherwise the only way to
 * make a deletion show up.
 *
 * Runs subtitle promotion first: any newly-dropped Subs folder should be
 * flattened into place before Jellyfin re-reads the folder, so the same
 * scan that notices a new file also notices its captions.
 */
export async function POST(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  try {
    const subtitles = await promoteSubtitles();
    if (subtitles.failed.length > 0) {
      console.error("[admin/library/scan] subtitle promotion failures:", subtitles.failed);
    }

    const body = await readJsonBody(request);
    const asked = body.folders === undefined ? [] : body.folders;
    if (!Array.isArray(asked) || asked.length > 20 || !asked.every((f) => typeof f === "string")) {
      throw new ValidationError("folders must be a list of up to 20 folder paths.");
    }
    const folders = (asked as string[]).map((typed) => {
      const path = toLibraryPath(typed, env.mediaLibraryPath, env.hostMediaPath);
      if (!path) throw new ValidationError(`“${typed}” is not a folder in the library.`);
      return path;
    });

    let scanned: string[] = [];
    if (folders.length > 0) scanned = (await refreshLibraryFolders(folders)).refreshed;
    if (scanned.length === 0) await refreshLibrary();
    // A scan is the whole point at which "what is in the library" changes, so
    // the cached listing must not answer for the next minute with the old one.
    invalidateAdminMovies();
    getDb()
      .prepare(
        `INSERT INTO health_last_scan (id, triggered_at) VALUES (1, ?)
         ON CONFLICT(id) DO UPDATE SET triggered_at = excluded.triggered_at`,
      )
      .run(Date.now());

    // Drop the scrapers' cached library snapshot before relinking, so the
    // pass below matches against the newest titles this process can see
    // rather than whatever the library looked like when the first scrape of
    // this container's lifetime ran. Only half the story on its own —
    // /Library/Refresh above returns as soon as Jellyfin *starts* scanning,
    // so anything it hasn't indexed yet is still invisible here; match.ts's
    // own TTL is what eventually catches those.
    invalidateLibraryIndex();

    // Fire-and-forget: a newly-scanned film might resolve mentions that were
    // sitting unmatched from before it was owned (a scraped review, an
    // accolade entry, a film-series slot). None of these existed as call
    // sites before now despite their own doc comments claiming this hook —
    // wiring them in here, not awaited, since a library with a real backlog
    // of unmatched rows could take a while and this response shouldn't wait
    // on it.
    void relinkUnmatchedArticleLinks().catch((error) =>
      console.error("[admin/library/scan] article relink failed:", error),
    );
    void relinkUnmatchedAccoladeEntries().catch((error) =>
      console.error("[admin/library/scan] accolade relink failed:", error),
    );
    void relinkUnmatchedFilmSeriesEntries().catch((error) =>
      console.error("[admin/library/scan] film-series relink failed:", error),
    );
    void relinkUnmatchedPickItems().catch((error) =>
      console.error("[admin/library/scan] pick relink failed:", error),
    );

    return Response.json(
      {
        scanning: true,
        scope: scanned.length > 0 ? "folders" : "library",
        folders: scanned,
        subtitlesPromoted: subtitles.promoted.length,
      },
      { headers: NO_STORE },
    );
  } catch (error) {
    if (error instanceof ValidationError) {
      return Response.json({ error: "invalid_request", message: error.message }, { status: 400, headers: NO_STORE });
    }
    if (error instanceof JellyfinError && error.status === 0) {
      console.error("[admin/library/scan] Jellyfin unreachable:", error.message);
      return Response.json(
        { error: "upstream_unavailable", message: "The media server is not responding." },
        { status: 502, headers: NO_STORE },
      );
    }
    console.error("[admin/library/scan] failed:", error);
    return Response.json(
      { error: "internal_error", message: "Could not start a library scan." },
      { status: 500, headers: NO_STORE },
    );
  }
}
