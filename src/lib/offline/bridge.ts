import type { OfflineBridge, OfflineBundle, OfflineManifest } from "./types";

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
  core?: { invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
  invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
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

  return {
    async start(manifest) {
      await plugin.start!({ manifest });
    },
    async list() {
      const result = (await plugin.list!()) as { bundles?: OfflineBundle[] } | OfflineBundle[];
      return Array.isArray(result) ? result : (result.bundles ?? []);
    },
    async remove(itemId) {
      await plugin.remove!({ itemId });
    },
    async localUrl(itemId, file) {
      const result = (await plugin.localUrl!({ itemId, file })) as { url?: string | null };
      const path = result?.url ?? null;
      if (!path) return null;
      // A raw file:// path is not loadable from the WebView; Capacitor
      // rewrites it onto its own scheme.
      return window.Capacitor?.convertFileSrc ? window.Capacitor.convertFileSrc(path) : path;
    },
  };
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
      return (await invoke("offline_local_url", { itemId, file })) as string | null;
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

/**
 * Fetches the manifest and hands it to the shell.
 *
 * The manifest is fetched HERE, from the page, because the page is the only
 * place with the session — the cookie is httpOnly, so the native side cannot
 * be given it and has to read its own cookie jar when it fetches the URLs
 * inside. Splitting it this way keeps the credential handling in the one
 * place that already has credentials.
 */
export async function startOfflineDownload(itemId: string): Promise<OfflineManifest> {
  const bridge = getOfflineBridge();
  if (!bridge) throw new Error("Offline downloads need the app.");

  const response = await fetch(`/api/download/${encodeURIComponent(itemId)}/manifest`, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(
      response.status === 404
        ? "That title is not available."
        : "Could not work out what to download.",
    );
  }
  const manifest = (await response.json()) as OfflineManifest;
  await bridge.start(manifest);
  return manifest;
}
