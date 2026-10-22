"use client";

import { useState } from "react";

/**
 * Under a friend's Watching now card: ask them to make it a watch party
 * (POST /api/together). They answer from their bell.
 */
export function AskToWatchTogether({ friendId, friendName, itemId }: { friendId: string; friendName: string; itemId: string }) {
  const [state, setState] = useState<"idle" | "busy" | "asked" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  async function ask() {
    if (state === "busy" || state === "asked") return;
    setState("busy");
    try {
      const response = await fetch("/api/together", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ friendId, itemId }),
      });
      const data = (await response.json().catch(() => ({}))) as { message?: string };
      if (response.ok) {
        setState("asked");
        setMessage(`Asked ${friendName}`);
      } else {
        // Asked a moment ago already reads as asked, not as a failure.
        setState(response.status === 429 ? "asked" : "error");
        setMessage(data.message ?? "Couldn't ask.");
      }
    } catch {
      setState("error");
      setMessage("No connection.");
    }
  }

  return (
    <div className="ask-together">
      <button type="button" className="btn ghost" disabled={state === "busy" || state === "asked"} onClick={() => void ask()}>
        {state === "asked" ? "✓ Asked" : "Watch together?"}
      </button>
      {message && state !== "asked" ? <span className="hint">{message}</span> : null}
    </div>
  );
}
