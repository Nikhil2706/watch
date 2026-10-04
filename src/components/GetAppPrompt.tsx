"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { androidBrowser, tvBrowser } from "@/lib/app-update";

const DISMISSED = "watch.getAppDismissed";

/**
 * Offers the Android app to an Android phone in a browser, and to an Android
 * TV in its browser; renders nothing anywhere else (in the app, on an iPhone,
 * on a desktop). Checked after mount, since only the browser knows.
 *
 * "link" is a plain line for the sign-in page. "banner" sits on Home and can
 * be dismissed for good on this browser — except on a TV, where the browser
 * is not a lesser way to watch but one that does not work with the remote
 * (see tvBrowser), so the offer stays.
 */
export function GetAppPrompt({ variant }: { variant: "link" | "banner" }) {
  const [show, setShow] = useState<"phone" | "tv" | null>(null);

  useEffect(() => {
    if (tvBrowser()) {
      setShow("tv");
      return;
    }
    if (!androidBrowser()) return;
    if (variant === "banner") {
      try {
        if (localStorage.getItem(DISMISSED)) return;
      } catch {
        /* storage blocked: show it; dismissing just won't stick */
      }
    }
    setShow("phone");
  }, [variant]);

  if (!show) return null;

  if (variant === "link") {
    return (
      <p className="auth-remote-links">
        {show === "tv" ? (
          <>
            <Link href="/app">Get the Watch app for this TV</Link> — it works with the remote; this browser does not.
          </>
        ) : (
          <>
            <Link href="/app">Get the Android app</Link> — keep films for offline, and it updates itself.
          </>
        )}
      </p>
    );
  }

  if (show === "tv") {
    return (
      <div className="get-app-banner" role="region" aria-label="Get the app">
        <div>
          <strong>Watch has an app for this TV</strong>
          <span>It works with the remote. In this browser you only get the pointer.</span>
        </div>
        <Link href="/app" className="btn">
          Get it
        </Link>
      </div>
    );
  }

  return (
    <div className="get-app-banner" role="region" aria-label="Get the app">
      <div>
        <strong>Watch is better in the app</strong>
        <span>Keep films for offline, and it updates itself.</span>
      </div>
      <Link href="/app" className="btn">
        Get it
      </Link>
      <button
        type="button"
        className="get-app-close"
        aria-label="Dismiss"
        onClick={() => {
          try {
            localStorage.setItem(DISMISSED, "1");
          } catch {
            /* ignore */
          }
          setShow(null);
        }}
      >
        ×
      </button>
    </div>
  );
}
