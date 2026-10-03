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

/**
 * Focusable, but never a D-pad stop. The favourite/rewatch toggles overlaid
 * on each poster sit above the poster's own link, so pressing down into a
 * row landed on a heart first, and one OK changed a list. On a TV they are
 * state indicators only (tv.css); the film page has the real buttons.
 *
 * Links out of the site ("Read on Wikipedia", "Powered by DoesTheDogDie")
 * are skipped too: a TV has no browser to hand them to, so OK did nothing.
 * YouTube is the exception — the trailer opens in the TV's YouTube app.
 */
const DPAD_SKIP_SELECTOR =
  '.list-overlay button, a[target="_blank"]:not([href*="youtube.com"]):not([href*="youtu.be"])';

export function getFocusableElements(root: ParentNode = document): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => isVisible(el) && !el.matches(DPAD_SKIP_SELECTOR),
  );
}

export interface Rect {
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

const EPSILON = 4;

/** How far apart two spans are on one axis; 0 when they overlap. */
function gapBetween(aMin: number, aMax: number, bMin: number, bMax: number): number {
  return Math.max(0, Math.max(aMin, bMin) - Math.min(aMax, bMax));
}

/**
 * How good `rect` is as the next stop from `current` going `direction`;
 * lower is better, null when it is not in that direction at all. Pure, so
 * it is tested without a DOM.
 *
 * Up/down measures sideways drift as the GAP between the two elements'
 * horizontal spans, not the distance between their centres. Centres made a
 * wide target directly below (a comment box, a search field) look far away —
 * its centre is half a screen to the right — so "down" from the rating stars
 * skipped the comment box for a poster further down. Anything that overlaps
 * the current column now counts as aligned, nearest first; the centre is
 * only a tie-break between equally aligned candidates.
 */
export function scoreCandidate(current: Rect, rect: Rect, direction: Direction): number | null {
  let primaryDistance: number;
  let secondaryDistance: number;
  let tieBreak = 0;

  if (direction === "right") {
    if (rect.left < current.right - EPSILON) return null;
    const rowHeight = Math.max(current.bottom - current.top, rect.bottom - rect.top);
    if (Math.abs(rect.centerY - current.centerY) > rowHeight * 1.2) return null;
    primaryDistance = rect.left - current.right;
    secondaryDistance = Math.abs(rect.centerY - current.centerY);
  } else if (direction === "left") {
    if (rect.right > current.left + EPSILON) return null;
    const rowHeight = Math.max(current.bottom - current.top, rect.bottom - rect.top);
    if (Math.abs(rect.centerY - current.centerY) > rowHeight * 1.2) return null;
    primaryDistance = current.left - rect.right;
    secondaryDistance = Math.abs(rect.centerY - current.centerY);
  } else if (direction === "down") {
    if (rect.top < current.bottom - EPSILON) return null;
    primaryDistance = rect.top - current.bottom;
    secondaryDistance = gapBetween(current.left, current.right, rect.left, rect.right);
    tieBreak = Math.abs(rect.centerX - current.centerX);
  } else {
    if (rect.bottom > current.top + EPSILON) return null;
    primaryDistance = current.top - rect.bottom;
    secondaryDistance = gapBetween(current.left, current.right, rect.left, rect.right);
    tieBreak = Math.abs(rect.centerX - current.centerX);
  }

  // Secondary axis weighted higher than primary: prefer a slightly farther
  // candidate that stays roughly aligned over a closer one that veers off,
  // which is what keeps up/down feel like moving between "columns" of a
  // grid rather than diagonal-jumping to whatever is nearest as the crow
  // flies.
  return primaryDistance + secondaryDistance * 2 + tieBreak * 0.05;
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

  let best: HTMLElement | null = null;
  let bestScore = Infinity;

  for (const candidate of candidates) {
    const score = scoreCandidate(currentRect, rectOf(candidate), direction);
    if (score !== null && score < bestScore) {
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
