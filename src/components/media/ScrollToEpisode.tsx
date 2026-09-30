"use client";

import { useEffect } from "react";

/**
 * Returning to a long show's collection page should land you back where
 * you left off, not at the top of a season list you've already finished.
 * A single scrollIntoView on the target episode's own poster link does
 * both halves of that at once — it walks up every scrollable ancestor, so
 * it scrolls the PAGE down to that episode's season row AND scrolls that
 * row horizontally to the tile, in one call. No coordinates, no separate
 * "find the season" step.
 *
 * Matches by the item id at the end of the poster's href
 * (`/item/{slug}-{id}`, see slugs.ts — the id is always the trailing
 * segment) rather than a dedicated DOM id, so this needs no change to
 * PosterCard/Row at all.
 */
export function ScrollToEpisode({ episodeId }: { episodeId: string | null }) {
  useEffect(() => {
    if (!episodeId) return;
    // A short delay, not requestAnimationFrame: row-scroll layout (fixed
    // aspect-ratio poster boxes, no image-load-driven reflow) is stable by
    // the next frame regardless, but giving the initial paint a moment
    // first avoids fighting the browser's own scroll-restoration on a
    // back-navigation into this page.
    const timer = setTimeout(() => {
      const link = document.querySelector<HTMLElement>(`a[href$="${episodeId}"]`);
      link?.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
      // TV: focus follows. Otherwise the page showed this episode while the
      // D-pad's focus stayed on a genre chip far above, off screen. Also
      // marked as the page's autofocus target: on a slow TV, TvProvider's
      // own landing focus can run after this timer and would move it back.
      if (link && document.documentElement.dataset.tv === "true") {
        link.setAttribute("data-tv-autofocus", "true");
        link.focus({ preventScroll: true });
      }
    }, 60);
    return () => clearTimeout(timer);
  }, [episodeId]);

  return null;
}
