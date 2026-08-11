"use client";

import { useState } from "react";

/**
 * Favourite / rewatch toggles on a poster.
 *
 * Optimistic: the icon flips immediately and only reverts if the request fails.
 * These sit on top of a card that is itself a link, so every handler has to stop
 * propagation — otherwise tapping the heart navigates to the film instead.
 */
export function ListButtons({
  itemId,
  initialFavourite,
  initialRewatch,
}: {
  itemId: string;
  initialFavourite: boolean;
  initialRewatch: boolean;
}) {
  const [favourite, setFavourite] = useState(initialFavourite);
  const [rewatch, setRewatch] = useState(initialRewatch);
  const [busy, setBusy] = useState<string | null>(null);

  async function toggle(
    kind: "favourite" | "rewatch",
    current: boolean,
    apply: (next: boolean) => void,
    event: React.MouseEvent,
  ) {
    event.preventDefault();
    event.stopPropagation();
    if (busy) return;

    setBusy(kind);
    apply(!current);
    try {
      const response = await fetch(`/api/lists/${itemId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind }),
      });
      if (!response.ok) {
        apply(current);
      } else {
        const data = (await response.json()) as { on?: boolean };
        if (typeof data.on === "boolean") apply(data.on);
      }
    } catch {
      apply(current);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="list-buttons">
      <button
        type="button"
        className={`chip-btn${favourite ? " on" : ""}`}
        aria-pressed={favourite}
        aria-label={favourite ? "Remove from favourites" : "Add to favourites"}
        title={favourite ? "In favourites" : "Add to favourites"}
        onClick={(e) => toggle("favourite", favourite, setFavourite, e)}
      >
        {favourite ? "★" : "☆"}
      </button>
      <button
        type="button"
        className={`chip-btn${rewatch ? " on" : ""}`}
        aria-pressed={rewatch}
        aria-label={rewatch ? "Remove from rewatch" : "Add to rewatch"}
        title={rewatch ? "On the rewatch list" : "Add to rewatch"}
        onClick={(e) => toggle("rewatch", rewatch, setRewatch, e)}
      >
        ↻
      </button>
    </div>
  );
}
