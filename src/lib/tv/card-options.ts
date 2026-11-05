/**
 * What a poster offers when OK is held on it with a remote (TvCardOptions).
 *
 * The overlay buttons on a poster (favourite, rewatch, mark watched, the ✕
 * that takes a title off Continue watching) are for a mouse or a finger. A
 * remote cannot reach them: the D-pad skips them on purpose, since a heart
 * that took focus on the way down a row was pressed by accident
 * (spatial-nav.ts). So on a TV the same actions live in a panel, and each
 * card says, in a data attribute, which ones apply to it.
 */
export interface CardOptions {
  itemId: string;
  title: string;
  /** The card's second line, e.g. "S2 E1 · Mechanic / Realtor" under a show's name. */
  subtitle?: string | null;
  /** The title's page. */
  infoHref: string;
  /** Plays it, from where it was left when there is a resume point. */
  playHref: string;
  resuming: boolean;
  favourite: boolean;
  rewatch: boolean;
  watched: boolean;
  /** On Continue watching: can be taken off it without marking it watched. */
  removable: boolean;
}

export const CARD_OPTIONS_ATTR = "data-tv-options";

/** How long OK must be held before it means "options" rather than "open". */
export const HOLD_MS = 450;

export function readCardOptions(value: string | null | undefined): CardOptions | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<CardOptions>;
    return typeof parsed.itemId === "string" && typeof parsed.title === "string" ? (parsed as CardOptions) : null;
  } catch {
    return null;
  }
}

export interface CardAction {
  key: "play" | "info" | "favourite" | "rewatch" | "watched" | "remove";
  label: string;
}

/** The panel's rows for one card, in order. */
export function cardActions(options: CardOptions): CardAction[] {
  const actions: CardAction[] = [
    { key: "play", label: options.resuming ? "Resume" : "Play" },
    { key: "info", label: "More info" },
    { key: "favourite", label: options.favourite ? "Remove from Favourites" : "Add to Favourites" },
    { key: "rewatch", label: options.rewatch ? "Remove from Rewatch" : "Add to Rewatch" },
    { key: "watched", label: options.watched ? "Mark as not watched" : "Mark as watched" },
  ];
  if (options.removable) actions.push({ key: "remove", label: "Remove from Continue watching" });
  return actions;
}
