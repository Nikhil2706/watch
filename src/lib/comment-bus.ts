import "server-only";

/**
 * Who is looking at which film's comments right now, so a new one reaches
 * them without a reload.
 *
 * In memory and on globalThis, for the reasons remote-bus.ts gives: one Node
 * process serves the whole site, so there is nobody else to tell, and a
 * restart only costs the open pages a reconnect — the comments themselves
 * are in the database. What travels is "something changed", never the
 * comment: each page then reads the thread again through the ordinary
 * route, so there is one place that decides what a viewer may see.
 */

type Listener = () => void;

const g = globalThis as { __commentListeners?: Map<string, Set<Listener>> };

function listeners(): Map<string, Set<Listener>> {
  return (g.__commentListeners ??= new Map());
}

/** Calls `listener` whenever this film's comments change. Returns the way to stop. */
export function subscribeComments(imdbId: string, listener: Listener): () => void {
  const all = listeners();
  const set = all.get(imdbId) ?? new Set<Listener>();
  all.set(imdbId, set);
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) all.delete(imdbId);
  };
}

/** Tells every open page on this film that its comments changed. Never throws. */
export function publishComments(imdbId: string): void {
  for (const listener of listeners().get(imdbId) ?? []) {
    try {
      listener();
    } catch {
      // One dead stream must not stop the others hearing about it.
    }
  }
}

/** How many pages are listening to this film, for a "N here now" line. */
export function commentListenerCount(imdbId: string): number {
  return listeners().get(imdbId)?.size ?? 0;
}
