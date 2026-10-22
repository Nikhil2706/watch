/**
 * The parts of keeping live streams that the watch party (party-bus.ts) and
 * the phone remote (remote-bus.ts) did each on their own: sending one message
 * to every open stream without one dead stream stopping the rest, sweeping
 * entries nobody has a stream open to, and capping how many idle entries one
 * owner may hold. Step 1 of docs/playback-sessions.md: no product rules here,
 * and both buses behave exactly as before.
 *
 * No "server-only" import: these are plain functions over plain data, tested
 * on their own (live-hub.test.ts).
 */

/**
 * Sends `message` to every listener except `except`. A listener that throws
 * (a stream that died between the last write and this one) is skipped; the
 * rest are still told. Returns how many were sent to without throwing.
 */
export function fanOut<L, M>(listeners: Iterable<L>, send: (listener: L, message: M) => void, message: M, except?: L): number {
  let delivered = 0;
  for (const listener of listeners) {
    if (listener === except) continue;
    try {
      send(listener, message);
      delivered += 1;
    } catch {
      // One dead stream must not stop the others from being told.
    }
  }
  return delivered;
}

export interface Liveness {
  /** Open streams on this entry right now. */
  streams: number;
  /** Last time anything was heard from it (a heartbeat, a subscribe, an unsubscribe). */
  lastSeen: number;
}

/**
 * Removes entries idle for longer than `ttlMs`. An entry with an open stream
 * is never swept, even if its heartbeat is late: the open stream is the
 * better sign of life, and dropping it would cut off a working device.
 * Returns the keys removed.
 */
export function sweepIdle<K, E>(entries: Map<K, E>, liveness: (entry: E) => Liveness, ttlMs: number, now: number): K[] {
  const removed: K[] = [];
  for (const [key, entry] of entries) {
    const l = liveness(entry);
    if (l.streams > 0) continue;
    if (now - l.lastSeen > ttlMs) {
      entries.delete(key);
      removed.push(key);
    }
  }
  return removed;
}

/**
 * Keeps one owner under `max` entries before a new one is added, by removing
 * their oldest entries with no open stream. A real device holds a stream open
 * and is never evicted; scripted registrations that never subscribe are
 * exactly what goes. Returns the keys removed.
 */
export function evictIdleOverflow<K, E>(
  entries: Map<K, E>,
  isOwners: (entry: E) => boolean,
  liveness: (entry: E) => Liveness,
  max: number,
): K[] {
  const owned = [...entries].filter(([, e]) => isOwners(e));
  if (owned.length < max) return [];
  const excess = owned.length - max + 1;
  const victims = owned
    .filter(([, e]) => liveness(e).streams === 0)
    .sort(([, a], [, b]) => liveness(a).lastSeen - liveness(b).lastSeen)
    .slice(0, excess)
    .map(([k]) => k);
  for (const k of victims) entries.delete(k);
  return victims;
}
