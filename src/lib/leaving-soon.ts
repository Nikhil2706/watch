/**
 * The rules for folders marked to be deleted, kept apart from the database
 * and the disk so they can be tested.
 *
 * A folder is marked in the console and deleted thirty days later, with
 * everything in it. Until then every film inside says so: a "Leaving soon"
 * row on Home and a badge on its poster wherever it is shown. These work out
 * which films a mark covers and how long they have.
 */

export const LEAVING_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface RemovalMark {
  /** The folder, as Jellyfin sees it: "/media/Horror/Wolf Creek". */
  path: string;
  deleteAt: number;
}

function isWithin(path: string, folder: string): boolean {
  return path === folder || path.startsWith(folder + "/");
}

/**
 * When the file or folder at `path` is due to be deleted, or null when no
 * mark covers it. A folder inside a marked folder goes when the first of the
 * marks above it does.
 */
export function leavingAt(path: string, marks: readonly RemovalMark[]): number | null {
  let soonest: number | null = null;
  for (const mark of marks) {
    if (!isWithin(path, mark.path)) continue;
    if (soonest === null || mark.deleteAt < soonest) soonest = mark.deleteAt;
  }
  return soonest;
}

/** Whole days until then, counting a part of a day as a day. Never negative. */
export function daysLeft(deleteAt: number, now: number): number {
  return Math.max(0, Math.ceil((deleteAt - now) / DAY_MS));
}

/** "12 days left", as it is written on a poster and beside a title. */
export function leavingLabel(days: number): string {
  if (days <= 0) return "Leaves today";
  return days === 1 ? "1 day left" : `${days} days left`;
}

/**
 * May this folder be marked at all? Only a folder inside the library: never
 * the library itself, never anything reached by going up out of it.
 */
export function isRemovableFolder(path: string, libraryRoot: string): boolean {
  const root = libraryRoot.replace(/\/+$/, "");
  if (!root || !path.startsWith(root + "/")) return false;
  const rest = path.slice(root.length + 1);
  if (!rest || rest.endsWith("/")) return false;
  return rest.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}
