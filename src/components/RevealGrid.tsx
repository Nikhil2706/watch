"use client";

import { Children, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * A grid that puts its tiles on the page a screenful at a time.
 *
 * Browse used to hand the browser every title in the library at once — some
 * 650 posters, each with its links and list buttons — and a TV's WebView took
 * seconds to lay that out before the remote did anything. The tiles are all
 * still here (the server sends them, so nothing is fetched later); only the
 * first `initial` are rendered, and more are added as the end of the grid
 * comes within reach of the screen, well before a remote or a scroll gets
 * there.
 *
 * How far a visitor got is remembered for the tab under `storageKey`, so Back
 * from a film returns to a grid long enough to hold the tile they opened —
 * which is what TvProvider's focus restore and the browser's scroll restore
 * both look for.
 */
export function RevealGrid({
  children,
  className,
  storageKey,
  initial = 60,
  step = 60,
}: {
  children: ReactNode;
  className?: string;
  /** Distinct per list: the same grid under another filter is another list. */
  storageKey: string;
  initial?: number;
  step?: number;
}) {
  const tiles = Children.toArray(children);
  const [shown, setShown] = useState(initial);
  const sentinel = useRef<HTMLDivElement>(null);
  const key = `reveal:${storageKey}`;

  // Before the first paint, so the page is already its remembered length when
  // scroll and focus are put back.
  useIsomorphicLayoutEffect(() => {
    let remembered = initial;
    try {
      remembered = Number(sessionStorage.getItem(key)) || initial;
    } catch {
      /* storage blocked: start from the top */
    }
    setShown(Math.max(initial, remembered));
  }, [key, initial]);

  useEffect(() => {
    try {
      sessionStorage.setItem(key, String(shown));
    } catch {
      /* ignore */
    }
  }, [key, shown]);

  useEffect(() => {
    const el = sentinel.current;
    if (!el || shown >= tiles.length) return;
    if (typeof IntersectionObserver === "undefined") {
      setShown(tiles.length);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setShown((current) => Math.min(tiles.length, current + step));
        }
      },
      // About four rows of posters ahead of the screen's bottom edge.
      { rootMargin: "0px 0px 1600px 0px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [shown, tiles.length, step]);

  return (
    <>
      <div className={className}>{tiles.slice(0, shown)}</div>
      {shown < tiles.length ? <div ref={sentinel} className="reveal-sentinel" aria-hidden="true" /> : null}
    </>
  );
}
