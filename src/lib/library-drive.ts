/**
 * Is the film drive really there? Asked before anything tells Jellyfin to
 * scan the library.
 *
 * The films are on an external exFAT drive. When it is unplugged, or macOS
 * drops it, the folder Jellyfin reads is empty or unreadable, and a scan
 * then decides every film was deleted: the items go, and with them the ids
 * everything in the site's database is keyed on. Jellyfin's own 12-hourly
 * scan did not ask; the site's scans do, through this.
 *
 * "There" means: the library folder can be listed, and most of the
 * top-level folders the library is known to have are in it and can be
 * listed too. "Most", not "all", so one genre folder deliberately removed
 * does not stop every scan afterwards (only a scan makes Jellyfin forget
 * it); an absent drive has none of them. MEDIA_EXPECTED_FOLDERS, when set,
 * names folders that must all be there.
 *
 * Kept free of Jellyfin and the environment so it can be tested.
 */

export interface DriveFs {
  /** Names of the entries in a folder, or a throw when it cannot be read. */
  readdir(path: string): string[];
  isDirectory(path: string): boolean;
}

export type DriveCheck =
  | { present: true; folders: string[] }
  | { present: false; reason: string };

function join(root: string, name: string): string {
  return root.endsWith("/") ? root + name : `${root}/${name}`;
}

/**
 * The top-level folder names of the library, from paths Jellyfin knows
 * ("/media/Horror/Hush" gives "Horror"). Paths outside the root, and the
 * root itself, give nothing.
 */
export function expectedTopFolders(paths: readonly string[], root: string): string[] {
  const base = root.replace(/\/+$/, "");
  const names = new Set<string>();
  for (const path of paths) {
    if (!path.startsWith(base + "/")) continue;
    const first = path.slice(base.length + 1).split("/")[0];
    if (first && !first.startsWith(".")) names.add(first);
  }
  return [...names].sort();
}

export function checkLibraryDrive(
  root: string,
  expected: { folders: readonly string[]; allRequired: boolean },
  fs: DriveFs,
): DriveCheck {
  let entries: string[];
  try {
    entries = fs.readdir(root);
  } catch (error) {
    return { present: false, reason: `the library folder ${root} cannot be read (${error instanceof Error ? error.message : String(error)})` };
  }
  const visible = entries.filter((name) => !name.startsWith("."));
  if (visible.length === 0) return { present: false, reason: `the library folder ${root} is empty` };

  const readable = (name: string): boolean => {
    try {
      if (!fs.isDirectory(join(root, name))) return false;
      fs.readdir(join(root, name));
      return true;
    } catch {
      return false;
    }
  };

  const wanted = [...new Set(expected.folders)];
  if (wanted.length > 0) {
    const missing = wanted.filter((name) => !readable(name));
    const found = wanted.length - missing.length;
    const enough = expected.allRequired ? missing.length === 0 : found * 2 >= wanted.length;
    if (!enough) {
      const shown = missing.slice(0, 5).join(", ") + (missing.length > 5 ? ` and ${missing.length - 5} more` : "");
      return {
        present: false,
        reason: `${missing.length} of the library's ${wanted.length} top-level folders are missing or unreadable (${shown})`,
      };
    }
  }
  return { present: true, folders: visible.sort() };
}
