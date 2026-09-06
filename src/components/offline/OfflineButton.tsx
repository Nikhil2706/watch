"use client";

import { useEffect, useState } from "react";

import { offlineSupported, startOfflineDownload } from "@/lib/offline/bridge";

/**
 * "Keep offline" on the item page.
 *
 * Renders nothing at all in an ordinary browser. This is feature detection,
 * not user-agent sniffing: the question is whether something here can store a
 * file, and the honest way to answer it is to look for the bridge that would
 * do the storing. A button that appears and then cannot work is worse than no
 * button.
 *
 * Deliberately not gated on Langlois mode. That grant is about taking the
 * original file away permanently; this is a sandboxed copy the app manages and
 * can delete, which is a different thing and reasonable for anyone with an
 * account. What a viewer may not do is get a title they cannot see — and they
 * cannot, because the manifest route resolves through the same session-scoped
 * accessor as every page.
 */
export function OfflineButton({ itemId, title }: { itemId: string; title: string }) {
  const [supported, setSupported] = useState(false);
  const [state, setState] = useState<"idle" | "starting" | "started" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  // In an effect, not during render: the bridge lives on window, and checking
  // it while rendering would disagree with the server-rendered HTML.
  useEffect(() => setSupported(offlineSupported()), []);

  if (!supported) return null;

  async function keep() {
    setState("starting");
    setMessage(null);
    try {
      const manifest = await startOfflineDownload(itemId);
      setState("started");
      setMessage(
        manifest.ready
          ? `Downloading “${title}”.`
          : // The worker has to produce a device-friendly copy first. Saying so
            // is better than a progress bar that sits at zero looking broken.
            `Preparing “${title}” — it will download once the server has it ready.`,
      );
    } catch (error) {
      setState("error");
      setMessage(error instanceof Error ? error.message : "Could not start that download.");
    }
  }

  return (
    <>
      <button
        className="btn ghost"
        onClick={() => void keep()}
        disabled={state === "starting" || state === "started"}
      >
        {state === "started" ? "✓ Keeping offline" : "⬇ Keep offline"}
      </button>
      {message ? <span className="offline-note">{message}</span> : null}
    </>
  );
}
