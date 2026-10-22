"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

/** The two buttons on /together/{id}: start a watch party, or not now. */
export function TogetherAnswer({ askId, filmHref }: { askId: string; filmHref: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [declined, setDeclined] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function answer(value: "start" | "decline") {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/together/${askId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answer: value }),
      });
      const data = (await response.json().catch(() => ({}))) as { roomId?: string | null; message?: string };
      if (!response.ok) {
        setError(data.message ?? "Couldn't do that.");
        return;
      }
      if (value === "start" && data.roomId) router.push(`/party/${data.roomId}`);
      else setDeclined(true);
    } catch {
      setError("No connection.");
    } finally {
      setBusy(false);
    }
  }

  if (declined) {
    return (
      <p className="hint">
        Not now, then. <Link href={filmHref}>Back to the film</Link>
      </p>
    );
  }
  return (
    <div className="together-actions">
      <button type="button" className="btn" disabled={busy} onClick={() => void answer("start")}>
        Start a watch party
      </button>
      <button type="button" className="btn ghost" disabled={busy} onClick={() => void answer("decline")}>
        Not now
      </button>
      {error ? <p className="hint">{error}</p> : null}
    </div>
  );
}
