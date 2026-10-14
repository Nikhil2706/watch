/**
 * Recovering a page left open across a deploy.
 *
 * Each build names its code chunks by content. A page loaded before a deploy
 * still asks for the old names, the server no longer has them, and the next
 * lazy load (the player, a route's code on navigation) fails. The TV app then
 * sat on "Something went wrong" until Home was pressed. Loading the page again
 * fetches the new build, so on a chunk-load failure the page reloads itself:
 * once. If the reload fails the same way, the failure is real, and showing the
 * error beats reloading forever. sessionStorage is the guard: it survives the
 * reload, belongs to this tab, and is gone when the tab is.
 *
 * No imports and no globals touched except through `deps`, so the guard is
 * tested directly (chunk-reload.test.ts).
 */

/** The sessionStorage key holding when this tab last reloaded for a missing chunk. */
export const CHUNK_RELOAD_KEY = "watch:chunk-reload-at";

/**
 * A reload more recent than this did not help, so another is not tried. Long
 * enough to cover a slow TV finishing the reload and failing again; short
 * enough that a tab left open across a second deploy, hours later, recovers
 * again.
 */
export const CHUNK_RELOAD_WINDOW_MS = 2 * 60_000;

const CHUNK_MESSAGES = [
  /loading (?:css )?chunk [^\s]+ failed/i, // webpack: "Loading chunk 123 failed."
  /failed to load chunk/i, // Turbopack: "Failed to load chunk /_next/static/chunks/…"
  /failed to fetch dynamically imported module/i, // Chrome, Android WebView
  /error loading dynamically imported module/i, // Firefox
  /importing a module script failed/i, // Safari
];

/** Whether an error is a code chunk that could not be loaded, rather than a bug. */
export function isChunkLoadError(error: unknown): boolean {
  if (!error) return false;
  const name = typeof error === "object" && "name" in error ? String((error as { name: unknown }).name) : "";
  if (name === "ChunkLoadError") return true;
  const message =
    typeof error === "string"
      ? error
      : typeof error === "object" && "message" in error
        ? String((error as { message: unknown }).message)
        : "";
  return CHUNK_MESSAGES.some((pattern) => pattern.test(message));
}

export interface ChunkReloadDeps {
  /** Null when the browser will not give us sessionStorage (blocked, private mode). */
  storage: Pick<Storage, "getItem" | "setItem"> | null;
  reload: () => void;
  now: () => number;
}

/**
 * Reloads the page if `error` is a chunk-load failure and this tab has not
 * just done so. True when it reloaded; the caller should then show nothing
 * alarming, since the page is about to be replaced.
 *
 * Without working storage there is no way to know a reload already happened,
 * so none is tried: one stuck error page is better than a loop.
 */
export function reloadOnceForChunkError(error: unknown, deps: ChunkReloadDeps): boolean {
  if (!isChunkLoadError(error) || !deps.storage) return false;
  try {
    const last = Number(deps.storage.getItem(CHUNK_RELOAD_KEY));
    if (Number.isFinite(last) && last > 0 && deps.now() - last < CHUNK_RELOAD_WINDOW_MS) return false;
    deps.storage.setItem(CHUNK_RELOAD_KEY, String(deps.now()));
  } catch {
    return false;
  }
  deps.reload();
  return true;
}

/** The same, against this browser's own sessionStorage and location. */
export function reloadOnceForChunkErrorInBrowser(error: unknown): boolean {
  if (typeof window === "undefined") return false;
  let storage: Storage | null = null;
  try {
    storage = window.sessionStorage;
  } catch {
    storage = null;
  }
  return reloadOnceForChunkError(error, {
    storage,
    reload: () => window.location.reload(),
    now: () => Date.now(),
  });
}

/**
 * A lazy import that reloads the page instead of failing when its chunk is
 * gone. After a reload starts, the returned promise never settles: whatever
 * was waiting for the module is about to be replaced along with the page.
 */
export function importOrReload<T>(load: () => Promise<T>): Promise<T> {
  return load().catch((error: unknown) => {
    if (reloadOnceForChunkErrorInBrowser(error)) return new Promise<T>(() => {});
    throw error;
  });
}
