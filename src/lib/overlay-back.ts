"use client";

import { useEffect } from "react";

/**
 * Lets the Android app's Back button close whatever is open on the page — a
 * menu, a dropdown, the offline player — before it navigates.
 *
 * The shell asks window.__watchCloseOverlay() on Back (see MainActivity) and
 * only falls through to its own behaviour when that returns false. Browser
 * history is deliberately not used: pushing an entry per open menu races with
 * the router when a link inside the menu is followed.
 */

type Closer = () => void;

const openOverlays: Closer[] = [];

/**
 * Conditional handlers (TvProvider's Back stack: the player stepping out of
 * a menu or its control bar). Asked innermost first, after the overlays; a
 * handler returns true when it used the Back press.
 */
const backHandlers: Array<() => boolean> = [];

declare global {
  interface Window {
    __watchCloseOverlay?: () => boolean;
  }
}

function install() {
  if (typeof window === "undefined" || window.__watchCloseOverlay) return;
  window.__watchCloseOverlay = () => {
    const close = openOverlays.pop();
    if (close) {
      close();
      return true;
    }
    for (let i = backHandlers.length - 1; i >= 0; i--) {
      if (backHandlers[i]?.()) return true;
    }
    return goBackAPage();
  };
}

interface NavEntry {
  index: number;
  url: string | null;
}
interface NavigationLike {
  canGoBack?: boolean;
  currentEntry?: NavEntry | null;
  entries?: () => NavEntry[];
}

/**
 * Nothing to close: go back a page here rather than leaving it to the shell.
 *
 * On a TV the app reloads its first page at launch (MainActivity adds
 * "AndroidTV" to the user agent), and after that the WebView cannot travel
 * back to that first entry: canGoBack() says false one page in, so Back
 * closed the app, and history.back() to it fails ("Invalid key"). Deeper
 * entries are fine. So on a TV, stepping back onto the first entry replaces
 * the current page with it instead. On the first page this returns false
 * and the shell leaves the app, as Android should.
 */
function goBackAPage(): boolean {
  const nav = (window as Window & { navigation?: NavigationLike }).navigation;
  if (!nav?.canGoBack) return false;
  const current = nav.currentEntry;
  const first = nav.entries?.()[0];
  const tv = document.documentElement.dataset.tv === "true";
  if (tv && current?.index === 1 && first?.url) {
    const firstUrl = new URL(first.url);
    // Already showing the first page (we replaced onto it): Back leaves.
    if (firstUrl.pathname + firstUrl.search === window.location.pathname + window.location.search) return false;
    window.location.replace(first.url);
    return true;
  }
  window.history.back();
  return true;
}

/** Installs the app's Back hook on every page (it also does history Back; see install). */
export function installAppBack(): void {
  install();
}

/** Lets the app's Back button ask `handler` too (see backHandlers). Returns the unregister. */
export function registerBackHandler(handler: () => boolean): () => void {
  install();
  backHandlers.push(handler);
  return () => {
    const i = backHandlers.lastIndexOf(handler);
    if (i !== -1) backHandlers.splice(i, 1);
  };
}

/** While `open`, Back calls `close` instead of navigating. Innermost first. */
export function useCloseOnBack(open: boolean, close: Closer): void {
  useEffect(() => {
    if (!open) return;
    install();
    openOverlays.push(close);
    return () => {
      const i = openOverlays.lastIndexOf(close);
      if (i !== -1) openOverlays.splice(i, 1);
    };
  }, [open, close]);
}
