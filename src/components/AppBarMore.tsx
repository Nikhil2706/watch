"use client";

import { useEffect, useRef } from "react";

/**
 * The phone top bar's overflow menu: everything the bottom tabs don't carry.
 *
 * A native details element, so it opens with no JavaScript at all; this only
 * adds closing it on an outside tap or Escape, which details does not do.
 */
export function AppBarMore({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    const close = (event: Event) => {
      const el = ref.current;
      if (!el?.open) return;
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !el.contains(event.target as Node)) {
        el.open = false;
      }
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, []);

  return (
    <details className="appbar-more" ref={ref}>
      <summary aria-label="More">
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <circle cx="5" cy="12" r="1.8" fill="currentColor" />
          <circle cx="12" cy="12" r="1.8" fill="currentColor" />
          <circle cx="19" cy="12" r="1.8" fill="currentColor" />
        </svg>
      </summary>
      <div className="appbar-more-menu">{children}</div>
    </details>
  );
}
