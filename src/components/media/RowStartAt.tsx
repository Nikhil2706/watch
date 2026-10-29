"use client";

import { useEffect } from "react";

/**
 * Opens a row scrolled to one of its cards: an episode page's "Episodes" row,
 * which holds every episode, starts on the next one.
 *
 * Only the row moves, sideways, with the card lined up at its start. The page
 * itself stays where it is and nothing takes focus (unlike ScrollToEpisode,
 * which is for landing on a collection page): the viewer is on the episode's
 * own Play button. On a TV, moving down from there lands on the card now at
 * the start of the row, the next episode, because spatial-nav.ts picks what
 * lines up below; left then walks back through earlier episodes, right on
 * through later ones.
 *
 * Finds the row by its aria-label (Row sets it from the title) and the card
 * by the item id at the end of its link, as ScrollToEpisode does, so Row and
 * PosterCard need no change.
 */
export function RowStartAt({ rowTitle, itemId }: { rowTitle: string; itemId: string | null }) {
  useEffect(() => {
    if (!itemId) return;
    // A moment after the first paint, as in ScrollToEpisode, so the browser's
    // own scroll restoration on a back-navigation has had its turn.
    const timer = setTimeout(() => {
      const row = document.querySelector<HTMLElement>(`section.row[aria-label="${CSS.escape(rowTitle)}"] .row-scroll`);
      const link = row?.querySelector<HTMLElement>(`a[href$="${CSS.escape(itemId)}"]`);
      if (!row || !link) return;
      let card: HTMLElement = link;
      while (card.parentElement && card.parentElement !== row) card = card.parentElement;
      const padding = Number.parseFloat(getComputedStyle(row).paddingLeft) || 0;
      row.scrollLeft += card.getBoundingClientRect().left - row.getBoundingClientRect().left - padding;
    }, 60);
    return () => clearTimeout(timer);
  }, [rowTitle, itemId]);

  return null;
}
