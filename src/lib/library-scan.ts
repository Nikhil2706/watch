import "server-only";

import { invalidateAdminMovies } from "./admin-library-cache";
import { getDb } from "./db";
import { refreshLibrary, refreshLibraryFolders } from "./jellyfin";
import { relinkUnmatchedPickItems } from "./picks";
import { relinkUnmatchedAccoladeEntries, relinkUnmatchedArticleLinks } from "./scraping/articles";
import { relinkUnmatchedFilmSeriesEntries } from "./scraping/film-series";
import { invalidateLibraryIndex } from "./scraping/match";
import { promoteSubtitles } from "./subtitle-promotion";

/**
 * A library scan, as the console's button and the scheduled job both run it.
 *
 * Subtitle promotion first: any newly-dropped Subs folder should be flattened
 * into place before Jellyfin re-reads the folder, so the same scan that
 * notices a new file also notices its captions.
 *
 * `folders` (library paths, already validated by the caller) narrows the scan
 * to where new files were put, which takes seconds where the whole library
 * takes minutes. If Jellyfin has no folder item for any of them, the whole
 * library is scanned instead; `scanned` says which folders were re-read, and
 * is empty for a full scan.
 */
export async function scanLibraryNow(
  folders: string[] = [],
): Promise<{ subtitlesPromoted: number; scanned: string[] }> {
  const subtitles = await promoteSubtitles();
  if (subtitles.failed.length > 0) {
    console.error("[library-scan] subtitle promotion failures:", subtitles.failed);
  }

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
  // accolade entry, a film-series slot, a pick's title). Not awaited, since a
  // library with a real backlog of unmatched rows could take a while and the
  // caller shouldn't wait on it.
  void relinkUnmatchedArticleLinks().catch((error) => console.error("[library-scan] article relink failed:", error));
  void relinkUnmatchedAccoladeEntries().catch((error) => console.error("[library-scan] accolade relink failed:", error));
  void relinkUnmatchedFilmSeriesEntries().catch((error) => console.error("[library-scan] film-series relink failed:", error));
  void relinkUnmatchedPickItems().catch((error) => console.error("[library-scan] pick relink failed:", error));

  return { subtitlesPromoted: subtitles.promoted.length, scanned };
}
