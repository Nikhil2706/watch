import type { OfflineBridge, OfflineManifest } from "./types";

/**
 * Downloads the server has not finished preparing yet.
 *
 * The media route answers 202 with a JSON note until the worker has produced
 * a device-friendly copy, and that can take hours for a film that needs
 * re-encoding. Handing the URL to the device's downloader before then would
 * either fail outright or save the note as the film. So an unprepared title is
 * remembered here and handed over once the server says it is ready — from
 * whatever page happens to be open, not only the one where it was requested.
 *
 * Everything is injected (storage, fetch, bridge) so this runs under node:test
 * with no browser.
 */

export interface PendingDownload {
  itemId: string;
  title: string;
  status: OfflineManifest["status"];
  progress: number;
  error: string | null;
  since: number;
}

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export const PENDING_KEY = "watch.offline.pending";

export function readPending(store: KeyValueStore | null): PendingDownload[] {
  if (!store) return [];
  try {
    const parsed: unknown = JSON.parse(store.getItem(PENDING_KEY) ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter(
          (p): p is PendingDownload =>
            !!p && typeof p === "object" && typeof (p as PendingDownload).itemId === "string",
        )
      : [];
  } catch {
    return [];
  }
}

export function writePending(store: KeyValueStore | null, list: PendingDownload[]): void {
  if (!store) return;
  try {
    store.setItem(PENDING_KEY, JSON.stringify(list));
  } catch {
    // Storage full or blocked. The download can still be restarted by hand.
  }
}

export class OfflineError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.status = status;
  }
}

export async function fetchManifest(fetcher: Fetcher, itemId: string): Promise<OfflineManifest> {
  const response = await fetcher(`/api/download/${encodeURIComponent(itemId)}/manifest`, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new OfflineError(
      response.status === 404
        ? "That title is not available."
        : response.status === 401
          ? "Sign in again to download."
          : "Could not work out what to download.",
      response.status,
    );
  }
  return (await response.json()) as OfflineManifest;
}

/**
 * Asks the server to prepare a title. The manifest route deliberately never
 * does this, so that looking does not start work; this is the commit.
 *
 * One byte is requested rather than the file: if the copy turns out to be
 * ready already, a plain GET would start streaming gigabytes into a fetch
 * that nobody reads.
 */
export async function requestPrepare(
  fetcher: Fetcher,
  itemId: string,
  retry: boolean,
): Promise<"queued" | "ready"> {
  const url = `/api/download/${encodeURIComponent(itemId)}${retry ? "?retry=1" : ""}`;
  const response = await fetcher(url, { headers: { Range: "bytes=0-0" } });
  if (response.status === 202) return "queued";
  if (response.status === 200 || response.status === 206) {
    await response.body?.cancel();
    return "ready";
  }
  let message = "The server could not prepare this title.";
  try {
    const body = (await response.json()) as { message?: string };
    if (body.message) message = body.message;
  } catch {
    // Not JSON; keep the generic message.
  }
  throw new OfflineError(message, response.status);
}

interface Deps {
  bridge: OfflineBridge;
  fetcher: Fetcher;
  store: KeyValueStore | null;
  now?: () => number;
}

/**
 * Keeps one title offline: hands it to the device now if the server copy is
 * ready, otherwise asks for it to be prepared and remembers it.
 */
export async function keepOffline(
  itemId: string,
  title: string,
  { bridge, fetcher, store, now = Date.now }: Deps,
): Promise<"downloading" | "preparing"> {
  let manifest = await fetchManifest(fetcher, itemId);

  if (!manifest.ready) {
    const outcome = await requestPrepare(fetcher, itemId, manifest.status === "failed");
    if (outcome === "ready") {
      manifest = await fetchManifest(fetcher, itemId);
    }
  }

  const others = readPending(store).filter((p) => p.itemId !== itemId);

  if (manifest.ready) {
    await bridge.start(manifest);
    writePending(store, others);
    return "downloading";
  }

  writePending(store, [
    ...others,
    {
      itemId,
      title,
      status: manifest.status === "failed" ? "pending" : manifest.status,
      progress: manifest.progress,
      error: null,
      since: now(),
    },
  ]);
  return "preparing";
}

/**
 * Checks every pending title once. Ready ones are handed to the device and
 * dropped from the list; failures stay listed with their reason so the
 * Downloads screen can say what happened instead of the entry vanishing.
 */
export async function resumePending({ bridge, fetcher, store }: Deps): Promise<PendingDownload[]> {
  const pending = readPending(store);
  if (pending.length === 0) return pending;

  const next: PendingDownload[] = [];
  for (const entry of pending) {
    if (entry.status === "failed") {
      next.push(entry);
      continue;
    }
    let manifest: OfflineManifest;
    try {
      manifest = await fetchManifest(fetcher, entry.itemId);
    } catch (error) {
      // 404: gone, or no longer visible to this account; nothing to wait for.
      if (error instanceof OfflineError && error.status === 404) continue;
      // Offline or signed out: try again next time.
      next.push(entry);
      continue;
    }

    if (manifest.ready) {
      try {
        await bridge.start(manifest);
        continue;
      } catch {
        next.push({ ...entry, status: "failed", error: "The device could not start the download." });
        continue;
      }
    }

    next.push({
      ...entry,
      status: manifest.status,
      progress: manifest.progress,
      error: manifest.status === "failed" ? "The server could not prepare this title." : null,
    });
  }

  writePending(store, next);
  return next;
}

export function forgetPending(store: KeyValueStore | null, itemId: string): void {
  writePending(store, readPending(store).filter((p) => p.itemId !== itemId));
}
