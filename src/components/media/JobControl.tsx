"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Pause / resume button on a processing card.
 *
 * Pausing suspends ffmpeg rather than killing it, so nothing already encoded is
 * thrown away — worth knowing, because the obvious alternative (cancel and
 * restart later) would discard hours of work on a long film.
 */
export function JobControl({
  jobId,
  status,
}: {
  jobId: string;
  status: "pending" | "running" | "paused";
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  // A queued job has no process to suspend yet.
  if (status === "pending") return null;

  const action = status === "paused" ? "resume" : "pause";

  async function onClick(event: React.MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    setPending(true);
    try {
      await fetch(`/api/jobs/${jobId}/control`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      // The worker polls for the signal every couple of seconds, so give it a
      // moment before re-rendering or the card flips straight back.
      setTimeout(() => {
        router.refresh();
        setPending(false);
      }, 2500);
    } catch {
      setPending(false);
    }
  }

  return (
    <button className="job-control" onClick={onClick} disabled={pending} type="button">
      {pending ? "…" : action === "pause" ? "⏸ Pause" : "▶ Resume"}
    </button>
  );
}
