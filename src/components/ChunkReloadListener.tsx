"use client";

import { useEffect } from "react";

import { reloadOnceForChunkErrorInBrowser } from "@/lib/chunk-reload";

/**
 * Renders nothing. Catches a missing code chunk that no error boundary sees —
 * a lazy load whose rejection nobody awaited, a route's code failing to load
 * mid-navigation — and reloads the page once for the new build, under the
 * same guard as error.tsx (chunk-reload.ts).
 */
export function ChunkReloadListener() {
  useEffect(() => {
    function onRejection(event: PromiseRejectionEvent) {
      if (reloadOnceForChunkErrorInBrowser(event.reason)) event.preventDefault();
    }
    function onError(event: ErrorEvent) {
      if (reloadOnceForChunkErrorInBrowser(event.error ?? event.message)) event.preventDefault();
    }
    window.addEventListener("unhandledrejection", onRejection);
    window.addEventListener("error", onError);
    return () => {
      window.removeEventListener("unhandledrejection", onRejection);
      window.removeEventListener("error", onError);
    };
  }, []);
  return null;
}
