"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";

/**
 * Thin progress bar across the top of the page during a navigation.
 *
 * Replaces the full-page spinner that used to live in src/app/loading.tsx. A
 * `loading.tsx` makes Next unmount the current page and render the fallback in
 * its place, which for a generic spinner means the whole app — AppBar included
 * — blanks out and then reappears. That reads as a flicker, not as progress.
 * With no loading.tsx the App Router keeps the current page on screen until
 * the next one is ready, and this bar is what says "your click registered".
 *
 * Browse keeps its own loading.tsx: its skeleton mirrors the real layout, so
 * replacing the page there genuinely looks like the page arriving. This bar
 * shows on those navigations too, which is consistent rather than conflicting.
 *
 * Two details that matter for how it feels:
 *  - Nothing renders for the first APPEAR_DELAY_MS. Most navigations resolve
 *    faster than that, and a bar that flashes on every quick click is worse
 *    than no bar at all.
 *  - The width eases toward 90% and stops. It cannot know real progress, and a
 *    bar that reaches 100% while you are still waiting is a lie; parking just
 *    short of the end reads as "still working".
 */

const APPEAR_DELAY_MS = 150;
/** Safety net: if a navigation never completes (blocked, cancelled), do not leave the bar stuck. */
const MAX_VISIBLE_MS = 20_000;

function NavProgressInner() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [visible, setVisible] = useState(false);
  const [width, setWidth] = useState(0);

  const appearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const creepTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const maxTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fadeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearAll = useCallback(() => {
    for (const t of [appearTimer, maxTimer, fadeTimer]) {
      if (t.current) clearTimeout(t.current);
      t.current = null;
    }
    if (creepTimer.current) clearInterval(creepTimer.current);
    creepTimer.current = null;
  }, []);

  const finish = useCallback(() => {
    clearAll();
    setWidth((w) => (w > 0 ? 100 : 0));
    // Let the 100% state paint before fading, or the bar just disappears
    // mid-travel and never reads as "done".
    fadeTimer.current = setTimeout(() => {
      setVisible(false);
      setWidth(0);
    }, 220);
  }, [clearAll]);

  const start = useCallback(() => {
    clearAll();
    appearTimer.current = setTimeout(() => {
      setVisible(true);
      setWidth(12);
      creepTimer.current = setInterval(() => {
        // Decelerating creep: fast at first, asymptotic near the top.
        setWidth((w) => (w >= 90 ? w : w + Math.max(0.4, (90 - w) * 0.08)));
      }, 120);
      maxTimer.current = setTimeout(() => finish(), MAX_VISIBLE_MS);
    }, APPEAR_DELAY_MS);
  }, [clearAll, finish]);

  // Any same-document link click starts the bar. Capture phase so it still
  // fires when a handler further in stops propagation.
  useEffect(() => {
    function onClick(event: MouseEvent) {
      if (event.defaultPrevented) return;
      // Modified clicks open a new tab; this document is not navigating.
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

      const anchor = (event.target as Element | null)?.closest?.("a");
      if (!(anchor instanceof HTMLAnchorElement)) return;
      if (anchor.target && anchor.target !== "_self") return;
      if (anchor.hasAttribute("download")) return;

      const href = anchor.getAttribute("href");
      if (!href || href.startsWith("#")) return;

      let url: URL;
      try {
        url = new URL(anchor.href, window.location.href);
      } catch {
        return;
      }
      if (url.origin !== window.location.origin) return;
      // Same page, no navigation to report.
      if (url.pathname === window.location.pathname && url.search === window.location.search) return;

      start();
    }

    document.addEventListener("click", onClick, true);
    // Browser back/forward is a navigation too.
    window.addEventListener("popstate", start);
    return () => {
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("popstate", start);
    };
  }, [start]);

  // The route actually changed — the new page is rendering, so we are done.
  useEffect(() => {
    finish();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname, searchParams]);

  useEffect(() => clearAll, [clearAll]);

  if (!visible) return null;

  return (
    <div className="nav-progress" role="progressbar" aria-label="Loading page" aria-busy="true">
      <span style={{ width: `${width}%` }} />
    </div>
  );
}

/**
 * useSearchParams needs a Suspense boundary or it opts the whole route out of
 * static rendering.
 */
export function NavProgress() {
  return (
    <Suspense fallback={null}>
      <NavProgressInner />
    </Suspense>
  );
}
