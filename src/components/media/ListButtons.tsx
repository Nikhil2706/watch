"use client";

import { useState } from "react";

/**
 * Favourite / rewatch toggles, overlaid on the poster art.
 *
 * These used to be two full-width buttons under every card, which turned a wall
 * of posters into a wall of chrome. Overlaying them keeps the artwork the thing
 * you look at: the heart only sits on top of the image, and on a pointer device
 * it stays hidden until you hover — unless it is already on, in which case it
 * has to stay visible because it is now information rather than a control.
 *
 * On touch there is no hover, so both icons are always shown at low opacity.
 *
 * Every handler stops propagation: these sit inside a card that is itself a
 * link, and without it tapping the heart would navigate to the film.
 */
export function ListButtons({
  itemId,
  initialFavourite,
  initialRewatch,
  variant = "overlay",
}: {
  itemId: string;
  initialFavourite: boolean;
  initialRewatch: boolean;
  /** "overlay" sits on the poster; "inline" is for the detail page hero. */
  variant?: "overlay" | "inline";
}) {
  const [favourite, setFavourite] = useState(initialFavourite);
  const [rewatch, setRewatch] = useState(initialRewatch);
  const [busy, setBusy] = useState(false);

  async function toggle(
    kind: "favourite" | "rewatch",
    current: boolean,
    apply: (next: boolean) => void,
    event: React.MouseEvent,
  ) {
    event.preventDefault();
    event.stopPropagation();
    if (busy) return;

    setBusy(true);
    // Optimistic: the icon flips at once and only reverts if the server
    // disagrees. A watchlist toggle that waits on a round trip feels broken.
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
      setBusy(false);
    }
  }

  return (
    <div
      className={`list-buttons list-${variant}${favourite || rewatch ? " has-active" : ""}`}
    >
      <button
        type="button"
        className={`icon-btn${favourite ? " on" : ""}`}
        aria-pressed={favourite}
        aria-label={favourite ? "Remove from favourites" : "Add to favourites"}
        title={favourite ? "In favourites" : "Add to favourites"}
        onClick={(e) => toggle("favourite", favourite, setFavourite, e)}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path
            d="M12 21s-7.5-4.7-9.6-9A5.4 5.4 0 0 1 12 6.1 5.4 5.4 0 0 1 21.6 12c-2.1 4.3-9.6 9-9.6 9z"
            // Filled when on, outlined when off — readable at a glance without
            // relying on colour alone.
            fill={favourite ? "currentColor" : "none"}
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      <button
        type="button"
        className={`icon-btn${rewatch ? " on" : ""}`}
        aria-pressed={rewatch}
        aria-label={rewatch ? "Remove from rewatch" : "Add to rewatch"}
        title={rewatch ? "On the rewatch list" : "Watch again"}
        onClick={(e) => toggle("rewatch", rewatch, setRewatch, e)}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path
            d="M3 12a9 9 0 1 1 3 6.7M3 20v-5h5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.9"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
    </div>
  );
}
