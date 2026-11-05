"use client";

import { useEffect, useState } from "react";

/**
 * Between programmes on a channel with fixed slots (channels.ts): the
 * programme has ended, or was cut at its slot, and the next one starts on
 * the timetable. Says what is next and counts down to it, then tunes in, so
 * the next episode starts on the mark rather than at whatever minute the
 * last one happened to finish.
 */
export function LiveIntermission({
  channelId,
  startsAtMs,
  nextTitle,
  nextLine,
  art,
}: {
  channelId: string;
  /** When the next programme starts (or the channel goes off air). */
  startsAtMs: number;
  nextTitle: string | null;
  nextLine: string | null;
  art: string | null;
}) {
  const [left, setLeft] = useState(() => Math.max(0, startsAtMs - Date.now()));

  useEffect(() => {
    const tick = () => {
      const ms = startsAtMs - Date.now();
      setLeft(Math.max(0, ms));
      if (ms <= 0) window.location.replace(`/live/${encodeURIComponent(channelId)}`);
    };
    tick();
    const timer = window.setInterval(tick, 250);
    return () => window.clearInterval(timer);
  }, [startsAtMs, channelId]);

  const seconds = Math.ceil(left / 1000);
  const countdown = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  const at = new Date(startsAtMs).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

  return (
    <div className="player-stage live-intermission">
      {art ? <img className="live-intermission-art" src={art} alt="" /> : null}
      <div className="live-intermission-text">
        {nextTitle ? (
          <>
            <p className="live-intermission-label">Next, at {at}</p>
            <p className="live-intermission-title">{nextTitle}</p>
            {nextLine ? <p className="live-intermission-line">{nextLine}</p> : null}
            <p className="live-intermission-count" aria-live="off">
              in {countdown}
            </p>
          </>
        ) : (
          <>
            <p className="live-intermission-title">That&apos;s the end of the lineup</p>
            <p className="live-intermission-line">This channel goes off air in {countdown}.</p>
          </>
        )}
      </div>
    </div>
  );
}
