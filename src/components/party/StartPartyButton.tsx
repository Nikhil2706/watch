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
        <svg viewBox="0 0 24 24" width="1em" height="1em" aria-hidden="true" focusable="false">
          <path
            d="M16 20v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 18.5V20M10 11.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM20 20v-1.5a3.5 3.5 0 0 0-2.6-3.4M15.5 4.6a3.5 3.5 0 0 1 0 6.8"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span>{busy ? "Starting…" : "Watch party"}</span>
      </button>
      {error ? <span className="party-start-error">{error}</span> : null}
    </>
  );
}
