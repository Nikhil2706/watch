"use client";

import type { MouseEvent } from "react";

import { SPECIAL_FEATURES_ANCHOR } from "./special-features-anchor";

/**
 * "Includes 3 special features", in the film's title/meta row.
 *
 * The features themselves sit far down the page, under the ratings, the
 * accolades and the subtitles, where most people never scroll. This says they
 * exist where everyone looks, and takes you there.
 *
 * A real link to the section's id, so it works before hydration and is a
 * D-pad stop on a TV like any other link (spatial-nav.ts treats every
 * `a[href]` as focusable). The click is taken over only to scroll smoothly
 * without putting a hash in the URL — Back on a TV would otherwise have to
 * step out of "#special-features" before it left the page — and, on a TV, to
 * move focus to the first feature. Left on this link, focus would be at the
 * top of a page now showing its bottom half, and the next arrow press would
 * scroll straight back up.
 */
export function SpecialFeaturesJump({ count }: { count: number }) {
  if (count <= 0) return null;

  function onClick(event: MouseEvent<HTMLAnchorElement>) {
    const section = document.getElementById(SPECIAL_FEATURES_ANCHOR);
    if (!section) return; // let the browser follow the hash
    event.preventDefault();

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    section.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });

    const first = section.querySelector<HTMLElement>("a[href]");
    if (document.documentElement.dataset.tv === "true" && first) {
      first.focus({ preventScroll: true });
    } else {
      // Keyboard and screen-reader users land on the section, not back at
      // the top; preventScroll so this does not cut the smooth scroll short.
      section.focus({ preventScroll: true });
    }
  }

  return (
    <a className="sf-jump" href={`#${SPECIAL_FEATURES_ANCHOR}`} onClick={onClick}>
      Includes {count} special feature{count === 1 ? "" : "s"}
    </a>
  );
}
