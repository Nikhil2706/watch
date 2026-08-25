"use client";

import { useEffect, useState } from "react";

/**
 * Shown on an item page in place of the subtitle chip row when a title has
 * none at all. Calls the consumer-facing counterpart of the curator's
 * Library Review action (see subtitle-fetch.ts) — same search-by-IMDb-id,
 * download-best-match, write-next-to-the-video pipeline, just triggered by
 * whoever's watching instead of a curator working through a review list.
 *
 * On mount it also checks OpenSubtitles' /features endpoint for how many
 * subtitles exist at all (see subtitles/check/route.ts) — that check never
 * touches the shared daily download quota, so it's safe to run on every
 * page view, and it means a viewer sees "23 available" or "none found"
 * before committing to a click rather than after.
 */
export function FetchSubtitlesButton({ itemId }: { itemId: string }) {
  const [state, setState] = useState<"idle" | "pending" | "done" | "miss" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [count, setCount] = useState<number | null | "checking">("checking");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/subtitles/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ itemId }),
    })
      .then((response) => response.json())
      .then((data: { count?: number | null }) => {
        if (!cancelled) setCount(data.count ?? null);
      })
      .catch(() => {
        if (!cancelled) setCount(null);
      });
    return () => {
      cancelled = true;
    };
  }, [itemId]);

  async function onClick() {
    setState("pending");
    setMessage(null);
    try {
      const response = await fetch("/api/subtitles/fetch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemId }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        status?: string;
        message?: string;
      };
      if (data.status === "found") {
        setState("done");
        setMessage(data.message ?? "Subtitle added — reload to see it.");
      } else {
        setState(data.status === "not_found" ? "miss" : "error");
        setMessage(data.message ?? "Could not fetch a subtitle for this title.");
      }
    } catch {
      setState("error");
      setMessage("No connection. Try again in a moment.");
    }
  }

  if (state === "done") {
    return (
      <div className="subtitle-line">
        <span className="subtitle-label">Subtitles</span>
        <span className="chip chip-accent">{message}</span>
      </div>
    );
  }

  // Checked and genuinely nothing exists on OpenSubtitles either — the
  // button would only ever fail, so don't offer it at all.
  if (count === 0) {
    return (
      <div className="subtitle-line">
        <span className="subtitle-label">Subtitles</span>
        <span className="subtitle-fetch-note">None found on OpenSubtitles either.</span>
      </div>
    );
  }

  return (
    <div className="subtitle-line">
      <span className="subtitle-label">Subtitles</span>
      <button type="button" className="chip" onClick={onClick} disabled={state === "pending"}>
        {state === "pending"
          ? "Searching OpenSubtitles…"
          : typeof count === "number"
            ? `None yet — ${count} available on OpenSubtitles`
            : "None yet — search OpenSubtitles"}
      </button>
      {(state === "miss" || state === "error") && message ? (
        <span className="subtitle-fetch-note">{message}</span>
      ) : null}
    </div>
  );
}
