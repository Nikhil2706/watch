"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * "I've seen this." Marks a film or episode watched, or takes the mark off.
 *
 * Two places: a tile on the film's own page ("inline"), and on a poster in
 * Continue watching ("overlay"), where it is the way to clear out something
 * you stopped ten minutes from the end of and are never going back to.
 *
 * The page is refreshed after a change, because what changes is the page:
 * the card leaves Continue watching, the Resume button becomes Play.
 */
export function WatchedButton({
  itemId,
  initialWatched,
  variant = "inline",
}: {
  itemId: string;
  initialWatched: boolean;
  variant?: "overlay" | "inline";
}) {
  const router = useRouter();
  const [watched, setWatched] = useState(initialWatched);
  const [busy, setBusy] = useState(false);

  async function toggle(event: React.MouseEvent) {
    // On a poster this sits inside the link to the film.
    event.preventDefault();
    event.stopPropagation();
    if (busy) return;
    setBusy(true);
    const next = !watched;
    setWatched(next);
    try {
      const response = await fetch(`/api/watched/${itemId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ watched: next }),
      });
      if (!response.ok) setWatched(!next);
      else router.refresh();
    } catch {
      setWatched(!next);
    } finally {
      setBusy(false);
    }
  }

  // Once watched, the button says what pressing it does: there was no other
  // way to find "mark unwatched", and "Watched" read as a state, not a control.
  const label = watched ? "Mark unwatched" : "Mark watched";
  return (
    <div className={`list-buttons list-${variant} watched-toggle${watched ? " has-active" : ""}`}>
      <button
        type="button"
        className={`icon-btn${watched ? " on" : ""}`}
        aria-pressed={watched}
        aria-label={watched ? "Mark as not watched" : "Mark as watched"}
        title={watched ? "You have watched this. Press to mark it unwatched." : "Mark as watched"}
        onClick={toggle}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path
            d="M4.5 12.5l5 5 10-11"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        {variant === "inline" ? <span className="icon-btn-label">{label}</span> : null}
      </button>
    </div>
  );
}
