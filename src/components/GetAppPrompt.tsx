"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { androidBrowser } from "@/lib/app-update";

const DISMISSED = "watch.getAppDismissed";

/**
 * Offers the Android app to an Android phone in a browser; renders nothing
 * anywhere else (in the app, on an iPhone, on a desktop). Checked after
 * mount, since only the browser knows.
 *
 * "link" is a plain line for the sign-in page. "banner" sits on Home and can
 * be dismissed for good on this browser.
 */
export function GetAppPrompt({ variant }: { variant: "link" | "banner" }) {
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (!androidBrowser()) return;
    if (variant === "banner") {
      try {
        if (localStorage.getItem(DISMISSED)) return;
      } catch {
        /* storage blocked: show it; dismissing just won't stick */
      }
    }
    setShow(true);
  }, [variant]);

  if (!show) return null;

  if (variant === "link") {
    return (
      <p className="auth-remote-links">
        <Link href="/app">Get the Android app</Link> — keep films for offline, and it updates itself.
      </p>
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
          setShow(false);
        }}
      >
        ×
      </button>
    </div>
  );
}
