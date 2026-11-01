"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * A row's scrolling strip, with ‹ › at whichever end has more to show.
 *
 * With a mouse there was no way along a row that runs off the screen: no
 * scrollbar is drawn (globals.css), and a wheel only scrolls the page. Picks
 * already had these arrows (PickRail); every Row now does, the same buttons
 * and the same rule. A phone swipes and a TV's focus scrolls the row itself,
 * so neither is shown them (.pk-arrow is hover-only), and they are not Tab
 * stops: the cards are, and tabbing to one scrolls it into view.
 *
 * The cards are rendered by Row on the server and handed in as children.
 */
export function RowRail({ className, label, children }: { className: string; label: string; children: ReactNode }) {
  const rail = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState({ left: false, right: false });

  useEffect(() => {
    const el = rail.current;
    if (!el) return;
    const measure = () => {
      const max = el.scrollWidth - el.clientWidth;
      setMore((was) => {
        const next = { left: el.scrollLeft > 4, right: el.scrollLeft < max - 4 };
        return was.left === next.left && was.right === next.right ? was : next;
      });
    };
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => {
      el.removeEventListener("scroll", measure);
      observer.disconnect();
    };
  }, []);

  function page(direction: 1 | -1) {
    const el = rail.current;
    // Most of a screenful, so the last card seen is still in view after.
    el?.scrollBy({ left: direction * el.clientWidth * 0.8, behavior: "smooth" });
  }

  return (
    <div className="row-rail">
      {more.left ? (
        <button type="button" className="pk-arrow pk-arrow-left row-arrow" tabIndex={-1} aria-label={`Back along ${label}`} onClick={() => page(-1)}>
          &#8249;
        </button>
      ) : null}
      {more.right ? (
        <button type="button" className="pk-arrow pk-arrow-right row-arrow" tabIndex={-1} aria-label={`On along ${label}`} onClick={() => page(1)}>
          &#8250;
        </button>
      ) : null}
      <div className={className} ref={rail}>
        {children}
      </div>
    </div>
  );
}
