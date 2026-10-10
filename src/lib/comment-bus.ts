/**
 * Who is looking at which film's comments right now, so a new one reaches
 * them without a reload — and so each of them can be told how many are
 * there.
 *
 * In memory and on globalThis, for the reasons remote-bus.ts gives: one Node
 * process serves the whole site, so there is nobody else to tell, and a
 * restart only costs the open pages a reconnect — the comments themselves
 * are in the database. What travels is "something changed", never the
 * comment: each page then reads the thread again through the ordinary
 * route, so there is one place that decides what a viewer may see.
 *
 * No server-only import, so it is testable; nothing here is a secret.
 */

export interface CommentListener {
  userId: string;
  /** A comment was posted, edited or deleted. */
  onChanged: () => void;
  /** Somebody arrived or left; `here` is how many people are on the page now. */
  onPresence: (here: number) => void;
}

const g = globalThis as { __commentListeners?: Map<string, Set<CommentListener>> };

function listeners(): Map<string, Set<CommentListener>> {
  return (g.__commentListeners ??= new Map());
}

function each(imdbId: string, call: (listener: CommentListener) => void): void {
  for (const listener of listeners().get(imdbId) ?? []) {
    try {
      call(listener);
    } catch {
      // One dead stream must not stop the others hearing about it.
    }
  }
}

/**
 * How many people have this film's page open. People, not pages: somebody
 * with it open on a phone and a TV is one person here.
 */
export function peopleHere(imdbId: string): number {
  return new Set([...(listeners().get(imdbId) ?? [])].map((l) => l.userId)).size;
}

function announcePresence(imdbId: string): void {
  const here = peopleHere(imdbId);
  each(imdbId, (l) => l.onPresence(here));
}

/** Adds a page to a film's listeners and tells everyone there. Returns the way to leave. */
export function subscribeComments(imdbId: string, listener: CommentListener): () => void {
  const all = listeners();
  const set = all.get(imdbId) ?? new Set<CommentListener>();
  all.set(imdbId, set);
  set.add(listener);
  announcePresence(imdbId);
  return () => {
    if (!set.delete(listener)) return;
    if (set.size === 0) all.delete(imdbId);
    announcePresence(imdbId);
  };
}

/** Tells every open page on this film that its comments changed. Never throws. */
export function publishComments(imdbId: string): void {
  each(imdbId, (l) => l.onChanged());
}
