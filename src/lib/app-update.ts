/**
 * The web side of in-app updates: window.Capacitor.Plugins.AppUpdate, from
 * AppUpdatePlugin.java (app 1.6 on). Older shells have no such plugin and
 * still get the launch prompt; they read as "in the app, can't ask it".
 */

import { isTvUserAgent } from "./tv/constants";

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
  return /Android/i.test(navigator.userAgent) && !/AndroidTV|\bTV\b/i.test(navigator.userAgent) && !tvBrowser();
}

/**
 * A TV in its own browser rather than in the app.
 *
 * The site looks the same there — big, laid out for a TV — but it is not the
 * same thing: a TV browser draws its own pointer and keeps the remote's arrow
 * keys to move it, so the page never sees them and none of the remote
 * handling can work. Nothing on the page can turn that pointer off. The app
 * is the fix, and androidBrowser() above leaves TVs out, so a TV was the one
 * place the app was never offered.
 *
 * Only an Android TV can install it. A browser that asks for the desktop site
 * hides "Android" from its user agent and is not recognised here; the /app
 * page says how to install on a TV for whoever lands on it another way.
 */
export function tvBrowser(): boolean {
  if (typeof navigator === "undefined" || typeof document === "undefined" || inApp()) return false;
  if (!/Android/i.test(navigator.userAgent)) return false;
  return document.documentElement.dataset.tv === "true" || isTvUserAgent(navigator.userAgent);
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
