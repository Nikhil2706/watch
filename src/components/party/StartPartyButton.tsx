"use client";

import { useState } from "react";

/** Posts /api/party/create for this title and navigates to the new room the moment it exists — no separate confirmation screen, matching "creator starts one, gets a shareable link" from the spec. */
export function StartPartyButton({ jellyfinId, className }: { jellyfinId: string; className?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/party/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jellyfinId }),
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as { message?: string } | null;
        setError(data?.message ?? "Could not start the party.");
        setBusy(false);
        return;
      }
      const { room } = (await response.json()) as { room: { id: string } };
      window.location.href = `/party/${room.id}`;
    } catch {
      setError("Could not start the party.");
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" className={className ?? "btn ghost"} onClick={start} disabled={busy}>
        {busy ? "Starting…" : "🎉 Watch party"}
      </button>
      {error ? <span className="party-start-error">{error}</span> : null}
    </>
  );
}
