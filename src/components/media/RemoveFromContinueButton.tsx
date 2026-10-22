"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * ✕ on a Continue watching card: takes it out of the row without marking it
 * watched (POST /api/continue/:itemId). It comes back if the title is played
 * again, or for a next episode, once a later one is watched.
 */
export function RemoveFromContinueButton({ itemId, title }: { itemId: string; title: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [gone, setGone] = useState(false);

  async function remove(event: React.MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    if (busy) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/continue/${itemId}`, { method: "POST" });
      if (response.ok) {
        setGone(true);
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="list-buttons list-overlay continue-remove">
      <button
        type="button"
        className="icon-btn"
        disabled={busy || gone}
        aria-label={`Remove ${title} from Continue watching`}
        title="Remove from Continue watching (it isn't marked watched)"
        onClick={remove}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}
