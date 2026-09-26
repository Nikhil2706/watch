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

declare global {
  interface Window {
    __watchCloseOverlay?: () => boolean;
  }
}

function install() {
  if (typeof window === "undefined" || window.__watchCloseOverlay) return;
  window.__watchCloseOverlay = () => {
    const close = openOverlays.pop();
    if (!close) return false;
    close();
    return true;
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
