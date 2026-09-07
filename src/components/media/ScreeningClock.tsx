"use client";

import { useEffect, useState } from "react";

/**
 * "Available for another 41 hours", counting down.
 *
 * Polls /api/screening/state once a minute so a revoke or an expiry becomes an
 * explanation rather than a player that dies mid-scene. A player that simply
 * stops reads as a bug; one that warns and then closes reads as a rule.
 */
export function ScreeningClock({ endsAt, compact = false }: { endsAt: number | null; compact?: boolean }) {
  const [remaining, setRemaining] = useState<number | null>(
    endsAt === null ? null : endsAt - Date.now(),
  );
  const [ended, setEnded] = useState(false);

  useEffect(() => {
    const tick = setInterval(() => {
      if (endsAt !== null) setRemaining(endsAt - Date.now());
    }, 1000 * 30);

    const poll = setInterval(async () => {
      try {
        const res = await fetch("/api/screening/state", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { state: string };
        if (data.state === "ended") setEnded(true);
      } catch {
        // A failed poll is not evidence the screening ended — leave it alone.
      }
    }, 60_000);

    return () => {
      clearInterval(tick);
      clearInterval(poll);
    };
  }, [endsAt]);

  if (ended) {
    return (
      <p className="screening-clock ending">
        This screening has ended. <a href="/s/unavailable?why=window_closed">More</a>
      </p>
    );
  }

  if (endsAt === null || remaining === null) {
    return <p className="screening-clock">Your window starts when you press play.</p>;
  }

  if (remaining <= 0) return <p className="screening-clock ending">This screening is closing.</p>;

  const hours = Math.floor(remaining / 3_600_000);
  const minutes = Math.floor((remaining % 3_600_000) / 60_000);
  const text =
    hours >= 1 ? `Available for another ${hours} hour${hours === 1 ? "" : "s"}` : `Ends in ${minutes} minutes`;

  return <p className={remaining < 5 * 60_000 ? "screening-clock ending" : "screening-clock"}>{compact ? text.replace("Available for another ", "") : text}</p>;
}
