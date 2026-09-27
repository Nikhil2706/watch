"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { startTransition, useEffect } from "react";

import { MobileTabBar } from "@/components/MobileTabBar";

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
  const router = useRouter();

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

  // The boundary replaces the whole page, app bar included, so it carries its
  // own way out: in the app there was otherwise nothing to tap but Back.
  return (
    <>
      <div className="empty">
        <strong style={{ color: "var(--text)", display: "block", marginBottom: 6 }}>Something went wrong</strong>
        <p>This page ran into a problem. It&apos;s been reported.</p>
        <div className="btn-row" style={{ justifyContent: "center", marginTop: 16 }}>
          <button
            className="btn ghost"
            onClick={() =>
              // reset() alone only re-renders on the client; a failure in a
              // server component needs the page fetched again.
              startTransition(() => {
                router.refresh();
                reset();
              })
            }
          >
            Try again
          </button>
          <Link href="/" className="btn ghost">
            Home
          </Link>
        </div>
      </div>
      <MobileTabBar />
    </>
  );
}
