"use client";

import { useEffect } from "react";

import {
  offlineSupported,
  pendingOfflineDownloads,
  resumeOfflineDownloads,
  syncOfflineWatched,
} from "@/lib/offline/bridge";

/**
 * Renders nothing. Hands titles the server has finished preparing to the
 * device's downloader from whatever page is open, so "Keep offline" works
 * without the viewer having to come back to the film or the Downloads screen.
 * And hands Jellyfin what was watched offline (offline/watched.ts) as soon as
 * there is a connection again, so it is in Recently watched and the history.
 *
 * Costs nothing when nothing is waiting: both lists are local storage, and
 * the network is only touched when one is non-empty.
 */
export function OfflineResume() {
  useEffect(() => {
    if (!offlineSupported()) return;
    const tick = () => {
      if (pendingOfflineDownloads().some((p) => p.status !== "failed")) {
        void resumeOfflineDownloads().catch(() => undefined);
      }
      void syncOfflineWatched().catch(() => undefined);
    };
    tick();
    const timer = setInterval(tick, 30_000);
    // Back from airplane mode: no need to wait for the next tick.
    window.addEventListener("online", tick);
    return () => {
      clearInterval(timer);
      window.removeEventListener("online", tick);
    };
  }, []);
  return null;
}
