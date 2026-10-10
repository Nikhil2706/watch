"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * The switch for "hide what I've seen".
 *
 * Kept on the account, not the device, so turning it on from a phone also
 * clears seen films out of the TV's rows. It changes what the page lists, so
 * the page is refreshed once the server has it.
 */
export function HideSeenToggle({ initialOn }: { initialOn: boolean }) {
  const router = useRouter();
  const [on, setOn] = useState(initialOn);
  const [busy, setBusy] = useState(false);

  async function toggle() {
    if (busy) return;
    setBusy(true);
    const next = !on;
    setOn(next);
    try {
      const response = await fetch("/api/prefs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hideWatched: next }),
      });
      if (!response.ok) setOn(!next);
      else router.refresh();
    } catch {
      setOn(!next);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      className={`hide-seen${on ? " on" : ""}`}
      role="switch"
      aria-checked={on}
      title={on ? "Films you have watched are hidden here. Press to show them." : "Hide the films you have already watched"}
      onClick={() => void toggle()}
    >
      <span className="hide-seen-dot" aria-hidden="true" />
      {on ? "Hiding what you've seen" : "Hide what I've seen"}
    </button>
  );
}
