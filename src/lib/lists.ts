import "server-only";

import { asRows, getDb } from "./db";

/**
 * Favourites and rewatch lists.
 *
 * Jellyfin has favourites of its own, but no notion of "rewatch". Keeping both
 * here rather than splitting them means the pair behaves identically — one list
 * would otherwise survive a Jellyfin rebuild and the other would not, which is
 * the kind of inconsistency nobody can reason about later.
 */

export type ListKind = "favourite" | "rewatch";

export const LIST_KINDS: readonly ListKind[] = ["favourite", "rewatch"];

export function isListKind(value: unknown): value is ListKind {
  return typeof value === "string" && (LIST_KINDS as readonly string[]).includes(value);
}

/** Item ids on a given list, newest first. */
export function getList(userId: string, kind: ListKind): string[] {
  return asRows<{ jellyfin_item_id: string }>(
    getDb()
      .prepare(
        `SELECT jellyfin_item_id FROM user_lists
          WHERE user_id = ? AND kind = ?
          ORDER BY created_at DESC`,
      )
      .all(userId, kind),
  ).map((row) => row.jellyfin_item_id);
}

/**
 * Which lists a user has each of these items on.
 *
 * Batched deliberately: a home page renders dozens of cards, and asking per
 * card would mean dozens of round trips to decide whether to fill in a heart.
 */
export function getMemberships(
  userId: string,
  itemIds: string[],
): Map<string, Set<ListKind>> {
  const result = new Map<string, Set<ListKind>>();
  if (itemIds.length === 0) return result;

  const placeholders = itemIds.map(() => "?").join(",");
  const rows = asRows<{ jellyfin_item_id: string; kind: ListKind }>(
    getDb()
      .prepare(
        `SELECT jellyfin_item_id, kind FROM user_lists
          WHERE user_id = ? AND jellyfin_item_id IN (${placeholders})`,
      )
      .all(userId, ...itemIds),
  );

  for (const row of rows) {
    const set = result.get(row.jellyfin_item_id) ?? new Set<ListKind>();
    set.add(row.kind);
    result.set(row.jellyfin_item_id, set);
  }
  return result;
}

/** Adds to a list. Idempotent — the primary key makes a repeat a no-op. */
export function addToList(userId: string, itemId: string, kind: ListKind): void {
  getDb()
    .prepare(
      `INSERT INTO user_lists (user_id, jellyfin_item_id, kind, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, jellyfin_item_id, kind) DO NOTHING`,
    )
    .run(userId, itemId, kind, Date.now());
}

export function removeFromList(userId: string, itemId: string, kind: ListKind): void {
  getDb()
    .prepare(
      "DELETE FROM user_lists WHERE user_id = ? AND jellyfin_item_id = ? AND kind = ?",
    )
    .run(userId, itemId, kind);
}

/** Flips membership and reports the new state, so one call serves a toggle. */
export function toggleList(
  userId: string,
  itemId: string,
  kind: ListKind,
): { on: boolean } {
  const existing = getDb()
    .prepare(
      "SELECT 1 AS found FROM user_lists WHERE user_id = ? AND jellyfin_item_id = ? AND kind = ?",
    )
    .get(userId, itemId, kind);

  if (existing) {
    removeFromList(userId, itemId, kind);
    return { on: false };
  }
  addToList(userId, itemId, kind);
  return { on: true };
}
