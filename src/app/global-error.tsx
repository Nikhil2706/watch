"use client";

import { useEffect } from "react";

/**
 * Root-layout error boundary — only fires when the crash is bad enough to
 * take out the layout itself, so this has to render its own <html>/<body>.
 * Same reporting as error.tsx, kept separate because Next requires this file
 * to be fully self-contained (it cannot assume globals.css or the root
 * layout rendered at all).
 */
export default function GlobalError({
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
        message: error.message || "Unhandled root-layout error",
        detail: { digest: error.digest, stack: error.stack?.slice(0, 2000), path: window.location.pathname, root: true },
      }),
    }).catch(() => {});
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          background: "#06070a",
          color: "#f2f4f8",
          font: "15px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          minHeight: "100dvh",
          textAlign: "center",
          padding: 20,
        }}
      >
        <div>
          <strong style={{ display: "block", marginBottom: 6, fontSize: "1.1rem" }}>Something went wrong</strong>
          <p style={{ color: "#939cad" }}>The site ran into a problem. It&apos;s been reported.</p>
          <button
            onClick={reset}
            style={{
              marginTop: 16,
              padding: "11px 20px",
              borderRadius: 8,
              fontWeight: 600,
              background: "rgba(255,255,255,.14)",
              color: "#f2f4f8",
              border: 0,
              cursor: "pointer",
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
