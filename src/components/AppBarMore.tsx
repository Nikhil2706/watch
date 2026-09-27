"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { useCloseOnBack } from "@/lib/overlay-back";

/**
 * The phone top bar's overflow menu: everything the bottom tabs don't carry.
 *
 * A native details element, so it opens with no JavaScript at all; this only
 * adds closing it on an outside tap, Escape, or the app's Back button, none of
 * which details does on its own.
 */
export function AppBarMore({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => {
    if (ref.current) ref.current.open = false;
  }, []);
  useCloseOnBack(open, close);

  useEffect(() => {
    const onOutside = (event: Event) => {
      const el = ref.current;
      if (!el?.open) return;
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !el.contains(event.target as Node)) {
        el.open = false;
      }
    };
    document.addEventListener("pointerdown", onOutside);
    document.addEventListener("keydown", onOutside);
    return () => {
      document.removeEventListener("pointerdown", onOutside);
      document.removeEventListener("keydown", onOutside);
    };
  }, []);

  return (
    <details className="appbar-more" ref={ref} onToggle={(e) => setOpen(e.currentTarget.open)}>
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
