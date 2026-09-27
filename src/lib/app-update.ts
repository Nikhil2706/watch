/**
 * The web side of in-app updates: window.Capacitor.Plugins.AppUpdate, from
 * AppUpdatePlugin.java (app 1.6 on). Older shells have no such plugin and
 * still get the launch prompt; they read as "in the app, can't ask it".
 */

export type AppUpdateStatus = {
  current: { code: number; name: string };
  /** null when the update server couldn't be reached. */
  latest: { code: number; name: string } | null;
  available: boolean;
  /** The debug build, which is updated by hand and never offered releases. */
  dev: boolean;
};

type UpdatePlugin = {
  status(): Promise<AppUpdateStatus>;
  update(): Promise<{ started: boolean; reason?: string }>;
};

type CapacitorWindow = Window & {
  Capacitor?: { isNativePlatform?: () => boolean; Plugins?: { AppUpdate?: UpdatePlugin } };
};

/** Inside the Android app at all (any version). */
export function inApp(): boolean {
  if (typeof window === "undefined") return false;
  const cap = (window as CapacitorWindow).Capacitor;
  return !!cap && (cap.isNativePlatform ? cap.isNativePlatform() : true);
}

export function getAppUpdater(): UpdatePlugin | null {
  if (typeof window === "undefined") return null;
  const plugin = (window as CapacitorWindow).Capacitor?.Plugins?.AppUpdate;
  return plugin && typeof plugin.status === "function" ? plugin : null;
}

/** An Android phone in a browser: someone the app could be offered to. */
export function androidBrowser(): boolean {
  if (typeof navigator === "undefined" || inApp()) return false;
  return /Android/i.test(navigator.userAgent) && !/AndroidTV|\bTV\b/i.test(navigator.userAgent);
}

const CACHE_KEY = "watch.appUpdateStatus";
const CACHE_MS = 10 * 60 * 1000;

/**
 * Asks the app, at most every ten minutes per tab: each ask is a request to
 * GitHub, and the menu renders on every page.
 */
export async function appUpdateStatus(force = false): Promise<AppUpdateStatus | null> {
  const plugin = getAppUpdater();
  if (!plugin) return null;
  if (!force) {
    try {
      const raw = sessionStorage.getItem(CACHE_KEY);
      if (raw) {
        const cached = JSON.parse(raw) as { at: number; status: AppUpdateStatus };
        if (Date.now() - cached.at < CACHE_MS) return cached.status;
      }
    } catch {
      /* storage unavailable: just ask */
    }
  }
  const status = await plugin.status();
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), status }));
  } catch {
    /* ignore */
  }
  return status;
}
