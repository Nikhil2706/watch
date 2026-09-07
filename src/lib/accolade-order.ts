/**
 * Reordering a curator's accolade list.
 *
 * A list like "best of 2026" is not written once. Films move in as the year
 * goes on, move out again, and move up and down — so the ordering operations
 * are the feature, not a nicety around it.
 *
 * The invariant everything here maintains: **slots are dense and zero-based**.
 * A list of five entries occupies slots 0,1,2,3,4 with no holes. That matters
 * because the console derives the next slot from the row count, so a hole made
 * a later "Add slot" collide with an existing entry and silently overwrite it
 * via upsert. Removing an entry therefore has to close the gap, not leave one.
 *
 * Pure, no server-only, no db handle: the ordering is the part worth testing,
 * and the SQL around it is a straight application of what these return.
 */

/** Where a new entry goes. Anything at or after it shifts down one. */
export function insertAt<T>(ids: readonly T[], id: T, position: number): T[] {
  const clamped = Math.max(0, Math.min(Math.floor(position), ids.length));
  const without = ids.filter((x) => x !== id);
  return [...without.slice(0, clamped), id, ...without.slice(clamped)];
}

/** Removes an entry and closes the gap behind it. */
export function removeFrom<T>(ids: readonly T[], id: T): T[] {
  return ids.filter((x) => x !== id);
}

/**
 * Moves an existing entry to an absolute position.
 *
 * Position is read against the list *without* the moved entry, which is what
 * makes "move #10 to #1" mean what a person means by it. A pairwise swap
 * cannot express that in fewer than nine steps.
 */
export function moveTo<T>(ids: readonly T[], id: T, position: number): T[] {
  if (!ids.includes(id)) return [...ids];
  return insertAt(ids, id, position);
}

/** Swaps with a neighbour. Kept because the console's up/down arrows are still the fastest way to nudge one row. */
export function moveByOne<T>(ids: readonly T[], id: T, direction: "up" | "down"): T[] {
  const idx = ids.indexOf(id);
  if (idx === -1) return [...ids];
  const target = direction === "up" ? idx - 1 : idx + 1;
  if (target < 0 || target >= ids.length) return [...ids];
  const next = [...ids];
  next[idx] = ids[target]!;
  next[target] = ids[idx]!;
  return next;
}

/**
 * The slot each entry should hold, dense and zero-based.
 *
 * Returns only the entries whose slot actually changes, so a reorder near the
 * bottom of a hundred-entry list writes two rows rather than a hundred.
 */
export function slotChanges<T>(
  ordered: readonly T[],
  current: ReadonlyMap<T, number>,
): Array<{ id: T; slot: number }> {
  const changes: Array<{ id: T; slot: number }> = [];
  ordered.forEach((id, index) => {
    if (current.get(id) !== index) changes.push({ id, slot: index });
  });
  return changes;
}

/** Are these slots already dense and zero-based? Used to decide whether a repair pass is needed. */
export function isDense(slots: readonly number[]): boolean {
  const sorted = [...slots].sort((a, b) => a - b);
  return sorted.every((s, i) => s === i);
}
