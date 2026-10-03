/**
 * The small pure rules behind scanning part of the library rather than all of
 * it, kept apart from Jellyfin and the environment so they can be tested.
 *
 * A full scan walks every folder of the library and takes minutes whatever
 * was added. Jellyfin will re-read one folder in seconds, but only a folder
 * it already knows — so a new film is picked up by refreshing the folder it
 * was put in, and these work out which folder that is.
 */

/** Forward slashes, no doubled or trailing ones. */
function tidy(path: string): string {
  const out = path.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  return out.length > 1 ? out.replace(/\/$/, "") : out;
}

function isWithin(path: string, root: string): boolean {
  return path === root || path.startsWith(root + "/");
}

/**
 * What the curator typed, as a path inside the library — or null when it is
 * somewhere else. Three ways to say it: the path Jellyfin sees
 * ("/media/Horror/Hush"), the folder as Explorer shows it
 * ("H:\Da Moveesh\Horror\Hush", when `hostRoot` is known), or just the part
 * under the library ("Horror/Hush").
 */
export function toLibraryPath(input: string, libraryRoot: string, hostRoot: string): string | null {
  const typed = tidy(input.trim());
  const root = tidy(libraryRoot);
  const host = hostRoot ? tidy(hostRoot) : "";
  if (!typed) return null;

  let path: string;
  if (host && isWithin(typed.toLowerCase(), host.toLowerCase())) {
    path = root + typed.slice(host.length);
  } else if (isWithin(typed, root)) {
    path = typed;
  } else if (typed.startsWith("/") || /^[a-z]:/i.test(typed)) {
    return null;
  } else {
    path = `${root}/${typed}`;
  }
  return path.split("/").includes("..") ? null : path;
}

/** The deepest of `folders` that is `path` or holds it; null when none does. */
export function nearestFolder<T extends { Path?: string }>(path: string, folders: readonly T[]): T | null {
  let best: T | null = null;
  for (const folder of folders) {
    if (!folder.Path || !isWithin(path, folder.Path)) continue;
    if (!best || folder.Path.length > best.Path!.length) best = folder;
  }
  return best;
}

/** `folders` without the ones that sit inside another of them, each once. */
export function outermostFolders<T extends { Path?: string }>(folders: readonly T[]): T[] {
  const unique = [...new Map(folders.filter((f) => f.Path).map((f) => [f.Path!, f])).values()];
  return unique.filter((f) => !unique.some((other) => other !== f && isWithin(f.Path!, other.Path!)));
}
