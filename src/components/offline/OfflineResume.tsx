"use client";

import { useEffect } from "react";

import {
  offlineSupported,
  pendingOfflineDownloads,
  resumeOfflineDownloads,
} from "@/lib/offline/bridge";

/**
 * Renders nothing. Hands titles the server has finished preparing to the
 * device's downloader from whatever page is open, so "Keep offline" works
 * without the viewer having to come back to the film or the Downloads screen.
 *
 * Costs nothing when nothing is waiting: the pending list is local storage,
 * and the network is only touched when it is non-empty.
 */
export function OfflineResume() {
  useEffect(() => {
    if (!offlineSupported()) return;
    const tick = () => {
      if (pendingOfflineDownloads().some((p) => p.status !== "failed")) {
        void resumeOfflineDownloads().catch(() => undefined);
      }
    };
    tick();
    const timer = setInterval(tick, 30_000);
    return () => clearInterval(timer);
  }, []);
  return null;
}
