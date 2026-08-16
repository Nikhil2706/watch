"use client";

import { useEffect } from "react";

/**
 * Route-segment error boundary. Catches a render crash anywhere under this
 * layout and reports it back to the server — otherwise a client-side crash
 * is invisible to everyone but the one person staring at their own browser
 * console when it happened.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    void fetch("/api/client-error", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: "react_boundary",
        message: error.message || "Unhandled render error",
        detail: { digest: error.digest, stack: error.stack?.slice(0, 2000), path: window.location.pathname },
      }),
    }).catch(() => {});
  }, [error]);

  return (
    <div className="empty">
      <strong style={{ color: "var(--text)", display: "block", marginBottom: 6 }}>Something went wrong</strong>
      <p>This page ran into a problem. It&apos;s been reported.</p>
      <div className="btn-row" style={{ justifyContent: "center", marginTop: 16 }}>
        <button className="btn ghost" onClick={reset}>
          Try again
        </button>
      </div>
    </div>
  );
}
