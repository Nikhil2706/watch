"use client";

import { useEffect, useRef, useState } from "react";

/**
 * A person's biography, clamped to four lines with a way to read the rest.
 *
 * The clamp is deliberate, not a data limit — the full text has always been in
 * the DOM. It exists because these bios come from TMDB via Jellyfin and often
 * run several paragraphs, and the bio sits directly above the filmography: left
 * unclamped, a long life story pushes the films themselves below the fold on
 * the one page whose job is to show them.
 *
 * The toggle only appears when the text actually overflows, so a two-line bio
 * doesn't get a pointless "Show more" under it. That has to be measured after
 * layout (scrollHeight vs clientHeight), which is the whole reason this is a
 * client component; it re-measures on resize because the clamp is line-based
 * and a narrower column overflows sooner.
 */
export function ExpandableBio({ text }: { text: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    function measure() {
      const node = ref.current;
      if (!node) return;
      // Only meaningful while clamped — once expanded there is nothing to
      // compare, so keep whatever the clamped state already told us.
      if (node.dataset.expanded === "true") return;
      setOverflowing(node.scrollHeight > node.clientHeight + 1);
    }

    measure();

    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [text]);

  return (
    <div className="person-bio-wrap">
      <p
        ref={ref}
        data-expanded={expanded ? "true" : "false"}
        className={expanded ? "person-bio person-bio-open" : "person-bio"}
      >
        {text}
      </p>
      {overflowing ? (
        <button type="button" className="person-bio-toggle" onClick={() => setExpanded((v) => !v)}>
          {expanded ? "Show less" : "Show more"}
        </button>
      ) : null}
    </div>
  );
}
