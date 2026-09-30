"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { DownloadIcon } from "@/components/DownloadIcon";
import { useTvMode } from "@/components/tv/TvProvider";
import {
  getOfflineBridge,
  offlineSupported,
  pendingOfflineDownloads,
  resumeOfflineDownloads,
  startOfflineDownload,
} from "@/lib/offline/bridge";

/**
 * "Keep offline" on the item page.
 *
 * Renders nothing at all in an ordinary browser. This is feature detection,
 * not user-agent sniffing: the question is whether something here can store a
 * file, and the honest way to answer it is to look for the bridge that would
 * do the storing. A button that appears and then cannot work is worse than no
 * button.
 *
 * It reflects what is already on the device. Starting a download clears any
 * earlier copy first, so a button that always offered "Keep offline" would
 * let a second tap throw away a finished film and fetch it again.
 *
 * Deliberately not gated on Langlois mode. That grant is about taking the
 * original file away permanently; this is a sandboxed copy the app manages and
 * can delete, which is a different thing and reasonable for anyone with an
 * account. What a viewer may not do is get a title they cannot see — and they
 * cannot, because the manifest route resolves through the same session-scoped
 * accessor as every page.
 */

type View =
  | { kind: "checking" }
  | { kind: "absent" }
  | { kind: "starting" }
  | { kind: "preparing"; progress: number }
  | { kind: "downloading"; progress: number }
  | { kind: "ready" }
  | { kind: "failed"; message: string };

export function OfflineButton({ itemId, title }: { itemId: string; title: string }) {
  // The TV app is the same APK, so the bridge exists there too; nobody keeps
  // a film offline on a television, and it would be one more D-pad stop.
  const tvMode = useTvMode();
  const [supported, setSupported] = useState(false);
  const [view, setView] = useState<View>({ kind: "checking" });

  const read = useCallback(async (): Promise<View> => {
    const bridge = getOfflineBridge();
    if (!bridge) return { kind: "absent" };

    const onDevice = (await bridge.list().catch(() => [])).find((b) => b.itemId === itemId);
    if (onDevice) {
      if (onDevice.state === "ready") return { kind: "ready" };
      if (onDevice.state === "failed") {
        return { kind: "failed", message: onDevice.error ?? "The download did not finish." };
      }
      return { kind: "downloading", progress: onDevice.progress };
    }

    const pending = pendingOfflineDownloads().find((p) => p.itemId === itemId);
    if (pending) {
      return pending.status === "failed"
        ? { kind: "failed", message: pending.error ?? "The server could not prepare this title." }
        : { kind: "preparing", progress: pending.progress };
    }
    return { kind: "absent" };
  }, [itemId]);

  // In an effect, not during render: the bridge lives on window, and checking
  // it while rendering would disagree with the server-rendered HTML.
  useEffect(() => {
    const ok = offlineSupported();
    setSupported(ok);
    if (ok) void read().then(setView);
  }, [read]);

  const moving = view.kind === "preparing" || view.kind === "downloading";
  useEffect(() => {
    if (!moving) return;
    const timer = setInterval(() => {
      void resumeOfflineDownloads()
        .catch(() => undefined)
        .then(read)
        .then(setView);
    }, 4000);
    return () => clearInterval(timer);
  }, [moving, read]);

  if (tvMode || !supported || view.kind === "checking") return null;

  async function keep() {
    setView({ kind: "starting" });
    try {
      await startOfflineDownload(itemId, title);
      setView(await read());
    } catch (error) {
      setView({
        kind: "failed",
        message: error instanceof Error ? error.message : "Could not start that download.",
      });
    }
  }

  switch (view.kind) {
    case "ready":
      return (
        <Link href="/downloads" className="btn ghost offline-btn is-ready" title="On this device">
          <svg viewBox="0 0 24 24" width="1em" height="1em" aria-hidden="true" focusable="false">
            <path
              d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM8 12.5l2.8 2.8L16.5 9.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.9"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span>Downloaded</span>
        </Link>
      );
    case "downloading":
      return (
        <Link href="/downloads" className="btn ghost offline-btn is-busy">
          <span>Downloading {view.progress}%</span>
          <i className="offline-meter" style={{ width: `${view.progress}%` }} />
        </Link>
      );
    case "preparing":
      return (
        <>
          <span className="btn ghost offline-btn is-busy" aria-live="polite">
            <span>Preparing{view.progress > 0 ? ` ${view.progress}%` : "…"}</span>
            <i className="offline-meter" style={{ width: `${view.progress}%` }} />
          </span>
          <span className="offline-note">
            The server is making a phone-friendly copy. It downloads by itself when ready — you
            can leave this page.
          </span>
        </>
      );
    case "starting":
      return (
        <button className="btn ghost offline-btn" disabled>
          Starting…
        </button>
      );
    case "failed":
      return (
        <>
          <button className="btn ghost offline-btn" onClick={() => void keep()}>
            ⟳ Try download again
          </button>
          <span className="offline-note is-error">{view.message}</span>
        </>
      );
    default:
      return (
        <button className="btn ghost offline-btn" onClick={() => void keep()}>
          <DownloadIcon />
          <span>Keep offline</span>
        </button>
      );
  }
}
