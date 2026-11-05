import "server-only";

import { readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";

import { holdAdminMoviesForScan } from "./admin-library-cache";
import { syncLeavingPick } from "./folder-removals";
import { asRows, getDb, transaction } from "./db";
import { env } from "./env";
import {
  listKnownMediaPaths,
  listLibraryFolderPaths,
  refreshFolders,
  refreshLibrary,
  resolveScanFolders,
} from "./jellyfin";
import { checkLibraryDrive, expectedTopFolders, type DriveCheck } from "./library-drive";
import { filesToHold, HELD_REASON_PREFIX, holdsToRelease } from "./library-folders";
import { relinkUnmatchedPickItems } from "./picks";
import { relinkUnmatchedAccoladeEntries, relinkUnmatchedArticleLinks } from "./scraping/articles";
import { relinkUnmatchedFilmSeriesEntries } from "./scraping/film-series";
import { invalidateLibraryIndex } from "./scraping/match";
import { promoteSubtitles } from "./subtitle-promotion";

/** A scan was refused because the film drive does not look like it is there. */
export class LibraryDriveAbsentError extends Error {}

/**
 * Whether the film drive is there, by library-drive.ts's rules, measured
 * against the folders Jellyfin knows (or MEDIA_EXPECTED_FOLDERS).
 */
export async function libraryDriveCheck(): Promise<DriveCheck> {
  const root = env.mediaLibraryPath;
  const expected =
    env.mediaExpectedFolders.length > 0
      ? { folders: env.mediaExpectedFolders, allRequired: true }
      : { folders: expectedTopFolders(await listLibraryFolderPaths(), root), allRequired: false };
  return checkLibraryDrive(root, expected, {
    readdir: (path) => readdirSync(path),
    isDirectory: (path) => statSync(path).isDirectory(),
  });
}

/** Throws LibraryDriveAbsentError, and says so in the log, when the drive does not look present. */
export async function assertLibraryDrivePresent(): Promise<void> {
  const drive = await libraryDriveCheck();
  if (drive.present) return;
  console.warn(`[library-scan] NOT scanning: the film drive looks absent — ${drive.reason}`);
  throw new LibraryDriveAbsentError(`The film drive looks absent: ${drive.reason}. Nothing was scanned.`);
}

/**
 * A library scan, as the console's button and the scheduled job both run it.
 * Refused (LibraryDriveAbsentError) when the film drive does not look present.
 *
 * Subtitle promotion first: any newly-dropped Subs folder should be flattened
 * into place before Jellyfin re-reads the folder, so the same scan that
 * notices a new file also notices its captions.
 *
 * `folders` (library paths, already validated by the caller) narrows the scan
 * to where new files were put, which takes seconds where the whole library
 * takes minutes. Only what is in those folders comes onto the site: Jellyfin
 * re-reads the folder above a new one (or the whole library, for a new
 * folder at the top), so every other new file it would find is held back
 * first (holdEverythingElse). `scanned` says which folders were re-read, and
 * is empty when the whole library was; `held` and `released` count holds.
 */
export async function scanLibraryNow(
  folders: string[] = [],
): Promise<{ subtitlesPromoted: number; scanned: string[]; held: number; released: number }> {
  // Before anything, subtitle promotion included: a scan of an empty or
  // unreadable library folder tells Jellyfin every film is gone.
  await assertLibraryDrivePresent();

  const subtitles = await promoteSubtitles();
  if (subtitles.failed.length > 0) {
    console.error("[library-scan] subtitle promotion failures:", subtitles.failed);
  }

  let scanned: string[] = [];
  let held = 0;
  let released = 0;
  if (folders.length > 0) {
    console.log(`[library-scan] scan asked for: ${folders.join(" | ")}`);
    ({ scanned, held, released } = await readOnly(folders, folders));
  } else {
    await refreshLibrary();
  }
  // A scan is the whole point at which "what is in the library" changes, so
  // the cached listing must not answer until it is over: held open here,
  // released by autoGroupAfterScan below once Jellyfin is idle.
  holdAdminMoviesForScan();
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
  // A file added to a folder that is already marked is leaving too.
  void syncLeavingPick().catch((error) => console.error("[library-scan] leaving pick not updated:", error));
  // New episodes of a series join their show once Jellyfin has finished
  // reading them; until then they are kept off the listings (media.ts).
  void import("./series-autogroup")
    .then((m) => m.autoGroupAfterScan())
    .catch((error) => console.error("[library-scan] episode grouping failed:", error));

  return { subtitlesPromoted: subtitles.promoted.length, scanned, held, released };
}

/**
 * Has Jellyfin re-read the folders holding `paths`, bringing onto the site
 * only new files inside `asked` (none, when `asked` is empty): every other
 * new file it will find is held back first (holdEverythingElse). A path with
 * no known folder above it but the library means the whole library is read,
 * with the same holds. `scanned` is empty when the whole library was read.
 */
export async function readOnly(
  paths: string[],
  asked: string[],
): Promise<{ scanned: string[]; held: number; released: number }> {
  const { folders: toRead } = await resolveScanFolders(paths);
  const roots = toRead.length > 0 ? toRead.map((f) => f.Path) : [env.mediaLibraryPath];
  const { held, released } = holdEverythingElse(roots, asked, await listKnownMediaPaths());
  console.log(`[library-scan] reading ${roots.join(" | ")}; held back ${held} other new file(s), released ${released}`);
  if (toRead.length > 0) await refreshFolders(toRead);
  else await refreshLibrary();
  return { scanned: toRead.length > 0 ? roots : [], held, released };
}

const VIDEO_EXTENSIONS = new Set([".mp4", ".mkv", ".avi", ".mov", ".m4v", ".wmv", ".flv", ".webm", ".ts", ".m2ts"]);

/** Every video file under `root`, by the path Jellyfin will give it. */
function videoFilesUnder(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (name.startsWith(".")) continue;
      const path = join(dir, name);
      let isDir = false;
      try {
        isDir = statSync(path).isDirectory();
      } catch {
        continue;
      }
      if (isDir) walk(path);
      else if (VIDEO_EXTENSIONS.has(extname(name).toLowerCase())) out.push(path);
    }
  };
  walk(root);
  return out;
}

/**
 * Before a scan of `asked`: hides every new file under `roots` that is not
 * in a folder asked for (filesToHold), and un-hides what earlier scans held
 * inside the folders asked for, so asking for a held show brings it on.
 * Only holds this made are released; a file the curator hid stays hidden.
 */
function holdEverythingElse(
  roots: string[],
  asked: string[],
  known: Set<string>,
): { held: number; released: number } {
  const onDisk = roots.flatMap(videoFilesUnder);
  const toHold = filesToHold(onDisk, known, asked);
  const what = asked.length > 0 ? `a scan of ${asked.join(", ")}` : "a re-read after a deletion";
  const reason = `${HELD_REASON_PREFIX} arrived with ${what} (${new Date().toISOString().slice(0, 10)}); release by scanning its folder`;
  const db = getDb();
  const heldRows = asRows<{ path: string }>(
    db.prepare("SELECT path FROM library_excluded WHERE reason LIKE ?").all(`${HELD_REASON_PREFIX}%`),
  ).map((r) => r.path);
  const toRelease = holdsToRelease(heldRows, asked);
  let held = 0;
  transaction(() => {
    const insert = db.prepare(
      "INSERT INTO library_excluded (path, reason, created_at) VALUES (?, ?, ?) ON CONFLICT(path) DO NOTHING",
    );
    const now = Date.now();
    for (const path of toHold) held += Number(insert.run(path, reason, now).changes);
    const remove = db.prepare("DELETE FROM library_excluded WHERE path = ?");
    for (const path of toRelease) remove.run(path);
  });
  return { held, released: toRelease.length };
}
