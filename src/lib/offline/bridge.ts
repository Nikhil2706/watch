import {
  forgetPending,
  keepOffline,
  readPending,
  resumePending,
  type KeyValueStore,
  type PendingDownload,
} from "./pending";
import type { OfflineBridge, OfflineBundle } from "./types";

/**
 * Finds the native shell hosting this page, if any.
 *
 * The same pages run in an ordinary desktop browser, where none of this
 * exists and every offline control must stay invisible rather than appear and
 * fail. That is why everything here is feature detection rather than user-agent
 * sniffing: the question is "can this thing store a file", and the honest way
 * to answer it is to look for the object that would do the storing.
 */

interface CapacitorGlobal {
  Plugins?: { Offline?: Record<string, (...args: unknown[]) => Promise<unknown>> };
  convertFileSrc?: (path: string) => string;
  isNativePlatform?: () => boolean;
}

interface TauriGlobal {
  core?: {
    invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
    convertFileSrc?: (path: string) => string;
  };
  invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  convertFileSrc?: (path: string) => string;
}

declare global {
  interface Window {
    Capacitor?: CapacitorGlobal;
    __TAURI__?: TauriGlobal;
  }
}

function capacitorBridge(): OfflineBridge | null {
  if (typeof window === "undefined") return null;
  const plugin = window.Capacitor?.Plugins?.Offline;
  if (!plugin) return null;

  const bridge: OfflineBridge = {
    async start(manifest) {
      await plugin.start!({ manifest });
    },
    async list() {
      const result = (await plugin.list!()) as
        | { bundles?: OfflineBundle[]; version?: number }
        | OfflineBundle[];
      if (Array.isArray(result)) return result;
      // Shells before 1.5 report no version, which reads as 0 and correctly
      // marks them stale: they cannot read subtitles back out.
      if (typeof result.version === "number") bridge.version = result.version;
      return result.bundles ?? [];
    },
    async remove(itemId) {
      await plugin.remove!({ itemId });
    },
    async localUrl(itemId, file) {
      const result = (await plugin.localUrl!({ itemId, file })) as { url?: string | null };
      const path = result?.url ?? null;
      if (!path) return null;
      // Shells from 1.5 hand media back as a URL on the page's own origin,
      // served natively with working Range (Capacitor's file route cannot
      // seek or size a film over 2 GB). Use it as given.
      if (/^https?:\/\//.test(path)) return path;
      // A raw file:// path is not loadable from the WebView; Capacitor
      // rewrites it onto its own scheme.
      return window.Capacitor?.convertFileSrc ? window.Capacitor.convertFileSrc(path) : path;
    },
    async readText(itemId, file) {
      // Missing from shells before 1.5, where Capacitor rejects the call as
      // unimplemented. Null means "no subtitles", so the film still plays.
      try {
        const result = (await plugin.readText!({ itemId, file })) as { text?: string | null };
        return result?.text ?? null;
      } catch {
        return null;
      }
    },
  };
  return bridge;
}

function tauriBridge(): OfflineBridge | null {
  if (typeof window === "undefined") return null;
  const tauri = window.__TAURI__;
  const invoke = tauri?.core?.invoke ?? tauri?.invoke;
  if (!invoke) return null;

  return {
    async start(manifest) {
      await invoke("offline_start", { manifest });
    },
    async list() {
      return (await invoke("offline_list")) as OfflineBundle[];
    },
    async remove(itemId) {
      await invoke("offline_remove", { itemId });
    },
    async localUrl(itemId, file) {
      const path = (await invoke("offline_local_url", { itemId, file })) as string | null;
      if (!path) return null;
      // Rust hands back a plain filesystem path; only the webview knows the
      // asset scheme that makes it loadable. A raw path in a src attribute
      // loads nothing, silently.
      const convert = tauri?.core?.convertFileSrc ?? tauri?.convertFileSrc;
      return convert ? convert(path) : path;
    },
    async readText(itemId, file) {
      return (await invoke("offline_read_text", { itemId, file })) as string | null;
    },
  };
}

let cached: OfflineBridge | null | undefined;

/** The shell's bridge, or null in a plain browser. Result is memoised. */
export function getOfflineBridge(): OfflineBridge | null {
  if (cached !== undefined) return cached;
  cached = capacitorBridge() ?? tauriBridge();
  return cached;
}

/** Whether to show offline controls at all. */
export function offlineSupported(): boolean {
  return getOfflineBridge() !== null;
}

/** Test seam — lets the UI tests run without a shell. */
export function __setOfflineBridge(bridge: OfflineBridge | null | undefined): void {
  cached = bridge;
}

function localStore(): KeyValueStore | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

const boundFetch = (url: string, init?: RequestInit) => fetch(url, init);

/**
 * Keeps a title offline. The manifest is fetched from the page, not the shell,
 * because the page is the only place with the session — the cookie is
 * httpOnly, so the native side reads its own cookie jar for the URLs inside.
 *
 * "preparing" means the server is still producing the copy; it is picked up
 * by resumeOfflineDownloads() from whichever page is open when it is ready.
 */
export async function startOfflineDownload(
  itemId: string,
  title: string,
): Promise<"downloading" | "preparing"> {
  const bridge = getOfflineBridge();
  if (!bridge) throw new Error("Offline downloads need the app.");

  const outcome = await keepOffline(itemId, title, {
    bridge,
    fetcher: boundFetch,
    store: localStore(),
  });
  // Starting a download is somebody saying they expect to be offline. That is
  // the moment to make sure the screen they will need survives without a
  // network — not the moment they open it, by which time it is too late.
  void prepareForOffline();
  return outcome;
}

/** Hands any server-ready titles to the device. Safe to call often. */
export async function resumeOfflineDownloads(): Promise<PendingDownload[]> {
  const bridge = getOfflineBridge();
  if (!bridge) return [];
  return resumePending({ bridge, fetcher: boundFetch, store: localStore() });
}

export function pendingOfflineDownloads(): PendingDownload[] {
  return readPending(localStore());
}

export function cancelPendingDownload(itemId: string): void {
  forgetPending(localStore(), itemId);
}

/**
 * Makes the offline shell durable. Both halves matter for the stated target of
 * a week away from a network:
 *
 *  - Cache Storage is evictable under storage pressure, and the eviction
 *    heuristics do not know that this origin is the only way to reach a film
 *    already sitting on the disk. persist() asks to be exempt; in an installed
 *    app it is normally granted without a prompt.
 *  - Precaching only happens at install, so a worker installed before this
 *    feature existed has no downloads screen cached. Asking it to warm now
 *    re-runs that list against the live network while there still is one.
 *
 * Both are best effort by design: a browser that refuses either should still
 * download the film.
 */
export async function prepareForOffline(): Promise<void> {
  try {
    if (typeof navigator !== "undefined" && navigator.storage?.persist) {
      if (!(await navigator.storage.persisted?.())) {
        await navigator.storage.persist();
      }
    }
  } catch {
    // Not supported, or refused. Downloads still work.
  }

  try {
    const registration = await navigator.serviceWorker?.ready;
    registration?.active?.postMessage({ type: "warm" });
  } catch {
    // No service worker (plain browser, or registration failed).
  }
}
