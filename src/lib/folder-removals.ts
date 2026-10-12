import "server-only";

import { lstat, readdir, realpath, rm } from "node:fs/promises";
import { cache } from "react";

import { getAdminMovies, invalidateAdminMovies } from "./admin-library-cache";
import { invalidate } from "./cache";
import { asRow, asRows, getDb } from "./db";
import { env } from "./env";
import { refreshLibrary, refreshLibraryFolders } from "./jellyfin";
import { daysLeft, isRemovableFolder, leavingAt, LEAVING_DAYS, type RemovalMark } from "./leaving-soon";
import { getGroup } from "./library-curation";

/**
 * Folders marked to be deleted from the library and from the drive.
 *
 * Marking is one click in the console and can be taken back at any time in
 * the thirty days that follow. Nothing is touched on the disk until then:
 * the mark only makes the films inside say "Leaving soon" (leaving-soon.ts).
 * The deleting is done by the scheduled job at the bottom of this file, and
 * that is the only code in this app that removes a film from the drive.
 *
 * Because that cannot be undone, the job is deliberately hard to trip:
 *   - a folder is deleted only on a run at least 20 hours AFTER an earlier
 *     run first saw it due. One wrong clock reading (the WSL clock has been
 *     seen to jump) cannot delete anything; it takes two, a day apart.
 *   - the path is checked again at the moment of deleting, on the disk: it
 *     must be a real folder (not a link), strictly inside the library.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const CONFIRM_GAP_MS = 20 * 60 * 60 * 1000;

interface RemovalRow {
  path: string;
  marked_at: number;
  delete_at: number;
  due_seen_at: number | null;
  deleted_at: number | null;
  files_deleted: number | null;
}

function activeRows(): RemovalRow[] {
  return asRows<RemovalRow>(
    getDb().prepare("SELECT * FROM folder_removals WHERE deleted_at IS NULL ORDER BY delete_at, path").all(),
  );
}

/** Every folder currently marked. One read per page render, however many posters ask. */
export const leavingMarks = cache((): RemovalMark[] => activeRows().map((r) => ({ path: r.path, deleteAt: r.delete_at })));

/**
 * How many days a title has left, or null when it is staying. For a film or
 * an episode that is its own file; a show's tile has no file, so it is the
 * soonest of its episodes'.
 */
export function leavingDaysForItem(item: { Id: string; Path?: string; Type?: string }): number | null {
  const marks = leavingMarks();
  if (marks.length === 0) return null;
  const paths = item.Path ? [item.Path] : item.Type === "Group" ? (getGroup(item.Id)?.paths ?? []) : [];
  let soonest: number | null = null;
  for (const path of paths) {
    const at = leavingAt(path, marks);
    if (at !== null && (soonest === null || at < soonest)) soonest = at;
  }
  return soonest === null ? null : daysLeft(soonest, Date.now());
}

export interface FolderRemoval {
  /** The part under the library, as the console names folders: "Horror/Wolf Creek". */
  folder: string;
  markedAt: number;
  deleteAt: number;
  /** Films and episodes the library holds inside it now. */
  titles: number;
}

const underLibrary = (path: string) => path.slice(env.mediaLibraryPath.replace(/\/+$/, "").length + 1);

export async function listFolderRemovals(): Promise<FolderRemoval[]> {
  const rows = activeRows();
  if (rows.length === 0) return [];
  const all = await getAdminMovies().catch(() => []);
  return rows.map((r) => ({
    folder: underLibrary(r.path),
    markedAt: r.marked_at,
    deleteAt: r.delete_at,
    titles: all.filter((m) => m.Path?.startsWith(r.path + "/")).length,
  }));
}

/** Marks a folder (a library path, already validated by the caller's use of toLibraryPath). Marking twice keeps the first date. */
export function markFolderForRemoval(path: string): { deleteAt: number } {
  if (!isRemovableFolder(path, env.mediaLibraryPath)) throw new Error("That folder cannot be marked.");
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO folder_removals (path, marked_at, delete_at) VALUES (?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET
         marked_at = CASE WHEN folder_removals.deleted_at IS NULL THEN folder_removals.marked_at ELSE excluded.marked_at END,
         delete_at = CASE WHEN folder_removals.deleted_at IS NULL THEN folder_removals.delete_at ELSE excluded.delete_at END,
         due_seen_at = CASE WHEN folder_removals.deleted_at IS NULL THEN folder_removals.due_seen_at ELSE NULL END,
         deleted_at = NULL, files_deleted = NULL`,
    )
    .run(path, now, now + LEAVING_DAYS * DAY_MS);
  const row = asRow<RemovalRow>(getDb().prepare("SELECT * FROM folder_removals WHERE path = ?").get(path))!;
  return { deleteAt: row.delete_at };
}

/** Takes the mark off. True when there was one. */
export function unmarkFolderForRemoval(path: string): boolean {
  const result = getDb().prepare("DELETE FROM folder_removals WHERE path = ? AND deleted_at IS NULL").run(path);
  return Number(result.changes) > 0;
}

/* ------------------------------------------------------------------ *
 * The deleting
 * ------------------------------------------------------------------ */

const VIDEO = /\.(mkv|mp4|avi|m4v|mov|wmv|mpg|mpeg|ts|webm|flv)$/i;

async function countVideos(dir: string): Promise<number> {
  let n = 0;
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory()) n += await countVideos(`${dir}/${entry.name}`);
    else if (entry.isFile() && VIDEO.test(entry.name)) n += 1;
  }
  return n;
}

/**
 * Deletes one folder from the drive, or says why not. The checks are made
 * against the disk as it is now, not against what was true when it was
 * marked.
 */
async function deleteFolder(path: string): Promise<{ files: number } | { refused: string }> {
  const root = env.mediaLibraryPath.replace(/\/+$/, "");
  if (!isRemovableFolder(path, root)) return { refused: "not a folder inside the library" };
  const info = await lstat(path).catch(() => null);
  // Already gone (deleted by hand, or the drive is not attached): nothing to
  // do, and with the drive missing certainly nothing to conclude.
  if (!info) {
    const libraryThere = await lstat(root).then((s) => s.isDirectory()).catch(() => false);
    return libraryThere ? { files: 0 } : { refused: "the library folder is not there" };
  }
  if (info.isSymbolicLink() || !info.isDirectory()) return { refused: "not a real folder" };
  const real = await realpath(path);
  const realRoot = await realpath(root);
  if (!real.startsWith(realRoot + "/")) return { refused: "resolves outside the library" };

  const files = await countVideos(path);
  await rm(path, { recursive: true, force: false });
  return { files };
}

export interface RemovalRun {
  deleted: Array<{ folder: string; files: number }>;
  /** Due for the first time on this run: they go on the next one. */
  confirmed: string[];
  refused: Array<{ folder: string; why: string }>;
}

/** The scheduled job: delete what is due and was already seen due on an earlier run. */
export async function runFolderRemovals(): Promise<RemovalRun> {
  const db = getDb();
  const now = Date.now();
  const run: RemovalRun = { deleted: [], confirmed: [], refused: [] };

  for (const row of activeRows()) {
    if (row.delete_at > now) continue;
    if (row.due_seen_at === null || now - row.due_seen_at < CONFIRM_GAP_MS) {
      if (row.due_seen_at === null) {
        db.prepare("UPDATE folder_removals SET due_seen_at = ? WHERE path = ?").run(now, row.path);
        run.confirmed.push(underLibrary(row.path));
      }
      continue;
    }
    // The mark may have been taken off while an earlier folder was deleting.
    if (!asRow(db.prepare("SELECT 1 AS x FROM folder_removals WHERE path = ? AND deleted_at IS NULL").get(row.path))) continue;

    try {
      const result = await deleteFolder(row.path);
      if ("refused" in result) {
        run.refused.push({ folder: underLibrary(row.path), why: result.refused });
        console.error(`[folder-removals] not deleting ${row.path}: ${result.refused}`);
        continue;
      }
      db.prepare("UPDATE folder_removals SET deleted_at = ?, files_deleted = ? WHERE path = ?").run(Date.now(), result.files, row.path);
      run.deleted.push({ folder: underLibrary(row.path), files: result.files });
      console.log(`[folder-removals] deleted ${row.path} (${result.files} video files), marked ${new Date(row.marked_at).toISOString()}`);
    } catch (error) {
      run.refused.push({ folder: underLibrary(row.path), why: error instanceof Error ? error.message : String(error) });
      console.error(`[folder-removals] failed to delete ${row.path}:`, error);
    }
  }

  if (run.deleted.length > 0) {
    // Jellyfin drops what is gone when the folder above is read again.
    const root = env.mediaLibraryPath.replace(/\/+$/, "");
    const parents = [...new Set(run.deleted.map((d) => `${root}/${d.folder}`.replace(/\/[^/]+$/, "")))];
    const refreshed = await refreshLibraryFolders(parents.filter((p) => p !== root)).catch(() => ({ refreshed: [] as string[] }));
    if (refreshed.refreshed.length < parents.length) await refreshLibrary().catch(() => undefined);
    invalidateAdminMovies();
    invalidate("all-movies");
  }
  return run;
}
