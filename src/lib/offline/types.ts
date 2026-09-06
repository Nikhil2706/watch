/**
 * The contract between the web UI and whichever native shell is hosting it.
 *
 * All three apps — Android phone, Android tablet, Windows — are the same web
 * pages in a WebView, so the offline UI is written once here. Only the storage
 * and the transfer differ, because a WebView cannot be trusted to hold several
 * gigabytes: browser storage is evictable, and on a phone that means the film
 * you saved for the flight is quietly gone by the time you board.
 *
 * So the native side owns the bytes and this describes what it must do.
 */

/** What one title's offline copy consists of. Produced by /api/download/:id/manifest. */
export interface OfflineManifest {
  itemId: string;
  title: string;
  year: number | null;
  durationSeconds: number | null;
  /** Prepare-job state on the server, not download state on this device. */
  status: "absent" | "pending" | "running" | "done" | "failed";
  progress: number;
  /** True once the server has a prepared file to hand over. */
  ready: boolean;
  sizeBytes: number | null;
  media: { url: string; contentType: string; filename: string };
  poster: string | null;
  subtitles: OfflineSubtitle[];
}

export interface OfflineSubtitle {
  index: number;
  label: string;
  language: string | null;
  recommended: boolean;
  isForced: boolean;
  /** Server URL to fetch from; Jellyfin renders WebVTT on demand. */
  url: string;
  /** Stable name to store it under, so every platform agrees. */
  filename: string;
}

/** State of a bundle ON THIS DEVICE — distinct from the server's prepare job. */
export type OfflineState = "absent" | "queued" | "downloading" | "ready" | "failed";

export interface OfflineBundle {
  itemId: string;
  title: string;
  year: number | null;
  durationSeconds: number | null;
  state: OfflineState;
  /** 0-100. Media only; the subtitles and poster are rounding error. */
  progress: number;
  bytesDone: number | null;
  bytesTotal: number | null;
  /** Set when state is "failed" — shown to the user, so keep it readable. */
  error?: string | null;
  subtitles: OfflineSubtitle[];
}

/**
 * What a shell must implement. Deliberately small: anything that can be done
 * in the web layer is done there instead, so a second platform is a few
 * functions rather than a second application.
 *
 * Note what is NOT here: no way to pass credentials. The session cookie is
 * httpOnly, so JavaScript cannot read it even to hand it over. Every shell
 * therefore has to attach cookies from its own store when fetching these
 * URLs — the WebView already holds them.
 */
/**
 * The contract version a shell implements.
 *
 * The site and the shells ship on different cadences — the web deploys, the
 * APK updates whenever someone accepts it — so an offline-cached page can be
 * arbitrarily older or newer than the shell hosting it. This is how they find
 * out, and the rule that follows is:
 *
 *   PLAYBACK OF AN EXISTING BUNDLE IS NEVER VERSION-GATED.
 *
 * Someone on a train with a downloaded film must be able to watch it whatever
 * the version numbers say. Management — starting new downloads, deleting —
 * may degrade with a visible "update the app" notice, because those need a
 * network anyway, so being told to update is actionable. Additions to this
 * interface must therefore be additive only.
 */
export const OFFLINE_BRIDGE_VERSION = 1;

export interface OfflineBridge {
  /** What this shell implements. Absent on a shell older than versioning. */
  version?: number;
  /** Begin fetching a bundle. Returns immediately; watch progress via list(). */
  start(manifest: OfflineManifest): Promise<void>;
  /** Everything stored on this device, including in-flight downloads. */
  list(): Promise<OfflineBundle[]>;
  /** Delete a bundle and its files. Safe to call for something absent. */
  remove(itemId: string): Promise<void>;
  /**
   * A URL the WebView can actually play or read — a file:// path is not one,
   * so each platform converts to whatever its WebView accepts
   * (Capacitor's convertFileSrc, Tauri's asset protocol).
   */
  localUrl(itemId: string, file: string): Promise<string | null>;

  /**
   * Reads a stored text file — in practice a subtitle — as a string.
   *
   * This exists because of a trap that would otherwise ship as "the film
   * plays offline but has no subtitles". Those local URLs are a different
   * ORIGIN from the page (Capacitor serves them over its own scheme, Tauri
   * over the asset protocol), and while <video> does not care about that,
   * <track> is CORS-restricted and silently loads nothing. Reading the VTT
   * through the bridge and turning it into a blob: URL sidesteps it — blob
   * URLs are same-origin. Subtitles are tens of kilobytes, so the round trip
   * costs nothing.
   */
  readText(itemId: string, file: string): Promise<string | null>;
}
