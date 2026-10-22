"use client";

import { useState } from "react";

/**
 * "Friends see what I watch": whether this viewer's watches, ratings and
 * reviews appear in friends' Home rows (POST /api/prefs activityVisibility).
 * On History, beside the list it is about.
 */
export function ActivityVisibility({ initial }: { initial: "friends" | "nobody" }) {
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);

  async function change(next: "friends" | "nobody") {
    if (busy || next === value) return;
    setBusy(true);
    const before = value;
    setValue(next);
    try {
      const response = await fetch("/api/prefs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ activityVisibility: next }),
      });
      if (!response.ok) setValue(before);
    } catch {
      setValue(before);
    } finally {
      setBusy(false);
    }
  }

  return (
    <label className="activity-visibility hint">
      Who sees what you watch, rate and review:{" "}
      <select value={value} disabled={busy} onChange={(e) => void change(e.target.value as "friends" | "nobody")}>
        <option value="friends">Friends</option>
        <option value="nobody">Only me</option>
      </select>
    </label>
  );
}
