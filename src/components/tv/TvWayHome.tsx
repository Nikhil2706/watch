"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

/**
 * A way back to Home on a page that has no header, shown on a TV only.
 *
 * Downloads and the phone remote leave the app bar out on purpose — one must
 * render with no network, the other is used one-handed in the dark — and get
 * out through the phone's tab bar or the browser's own Back. A TV has
 * neither: nothing links to these pages there, but a pasted address, an old
 * bookmark or a notification can land on one, and then the remote had
 * nothing on the page to move to.
 *
 * Decided after mount from <html data-tv>, so the pages stay static (the
 * Downloads page has to render offline) and a phone never sees it.
 */
export function TvWayHome() {
  const [tv, setTv] = useState(false);

  useEffect(() => {
    setTv(document.documentElement.dataset.tv === "true");
  }, []);

  if (!tv) return null;
  return (
    <p className="tv-way-home">
      <Link href="/" className="btn" data-tv-autofocus="true">
        ‹ Home
      </Link>
      <span>This page is for phones.</span>
    </p>
  );
}
