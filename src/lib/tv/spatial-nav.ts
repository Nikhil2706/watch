/**
 * Geometric spatial navigation over whatever is already focusable in the DOM.
 *
 * Deliberately not a per-component thing: every card, button and link in this
 * app is already a real `<a>`/`<button>`, so there is nothing to wire up per
 * page. This just answers one question — "given the currently focused
 * element and a direction, which OTHER focusable element is the best match?"
 * — by treating on-screen position as the only signal. Same approach used by
 * the CSS Spatial Navigation draft and most TV focus-navigation libraries.
 */

export type Direction = "up" | "down" | "left" | "right";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function isVisible(el: HTMLElement): boolean {
  if (el.hidden) return false;
  // offsetParent is null for display:none (and for position:fixed in some
  // browsers, which nothing focusable here uses) — cheap and good enough.
  if (el.offsetParent === null && el.getClientRects().length === 0) return false;
  const style = window.getComputedStyle(el);
  if (style.visibility === "hidden" || style.display === "none") return false;
  if (el.closest("[aria-hidden='true']")) return false;
  return true;
}

export function getFocusableElements(root: ParentNode = document): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(isVisible);
}

interface Rect {
  top: number;
  left: number;
  right: number;
  bottom: number;
  centerX: number;
  centerY: number;
}

function rectOf(el: HTMLElement): Rect {
  const r = el.getBoundingClientRect();
  return {
    top: r.top,
    left: r.left,
    right: r.right,
    bottom: r.bottom,
    centerX: r.left + r.width / 2,
    centerY: r.top + r.height / 2,
  };
}

/**
 * Finds the best focus candidate in `direction` from `current`.
 *
 * Left/right is constrained to roughly the same row (the candidate's
 * vertical center must be within ~1.2 row-heights of the current element's)
 * so that reaching the end of a horizontal row of posters does nothing
 * instead of leaping into a different row below — "focus should not
 * unexpectedly jump to unrelated elements" from the brief. Up/down has no
 * equivalent horizontal constraint (moving between sections legitimately
 * changes column), but is still weighted heavily toward horizontal
 * alignment so it lands roughly under/over where focus already was.
 */
export function findNextFocusable(
  current: HTMLElement,
  direction: Direction,
  root: ParentNode = document,
): HTMLElement | null {
  const currentRect = rectOf(current);
  const candidates = getFocusableElements(root).filter((el) => el !== current);

  const EPSILON = 4;
  let best: HTMLElement | null = null;
  let bestScore = Infinity;

  for (const candidate of candidates) {
    const rect = rectOf(candidate);

    let primaryDistance: number;
    let secondaryDistance: number;

    if (direction === "right") {
      if (rect.left < currentRect.right - EPSILON) continue;
      const rowHeight = Math.max(currentRect.bottom - currentRect.top, rect.bottom - rect.top);
      if (Math.abs(rect.centerY - currentRect.centerY) > rowHeight * 1.2) continue;
      primaryDistance = rect.left - currentRect.right;
      secondaryDistance = Math.abs(rect.centerY - currentRect.centerY);
    } else if (direction === "left") {
      if (rect.right > currentRect.left + EPSILON) continue;
      const rowHeight = Math.max(currentRect.bottom - currentRect.top, rect.bottom - rect.top);
      if (Math.abs(rect.centerY - currentRect.centerY) > rowHeight * 1.2) continue;
      primaryDistance = currentRect.left - rect.right;
      secondaryDistance = Math.abs(rect.centerY - currentRect.centerY);
    } else if (direction === "down") {
      if (rect.top < currentRect.bottom - EPSILON) continue;
      primaryDistance = rect.top - currentRect.bottom;
      secondaryDistance = Math.abs(rect.centerX - currentRect.centerX);
    } else {
      if (rect.bottom > currentRect.top + EPSILON) continue;
      primaryDistance = currentRect.top - rect.bottom;
      secondaryDistance = Math.abs(rect.centerX - currentRect.centerX);
    }

    // Secondary axis weighted higher than primary: prefer a slightly farther
    // candidate that stays roughly aligned over a closer one that veers off,
    // which is what keeps up/down feel like moving between "columns" of a
    // grid rather than diagonal-jumping to whatever is nearest as the crow
    // flies.
    const score = primaryDistance + secondaryDistance * 2;
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  return best;
}

/** Scrolls a newly focused element into view, biased toward the axis that just moved. */
export function scrollFocusedIntoView(el: HTMLElement, direction: Direction): void {
  const behavior: ScrollBehavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ? "auto"
    : "smooth";
  el.scrollIntoView({
    behavior,
    block: direction === "up" || direction === "down" ? "center" : "nearest",
    inline: direction === "left" || direction === "right" ? "center" : "nearest",
  });
}

export function isTextEditable(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === "TEXTAREA") return true;
  if (tag === "INPUT") {
    const type = (el as HTMLInputElement).type;
    return !["button", "submit", "reset", "checkbox", "radio", "range", "color", "file"].includes(type);
  }
  return (el as HTMLElement).isContentEditable === true;
}
