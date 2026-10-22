import "server-only";

import { asRows, getDb } from "./db";

/**
 * "Remove from Continue watching", per viewer (continue_removed, v62). See
 * next-up.ts continueWatchingOrder for how long a removal holds.
 */

export function removeFromContinue(userId: string, itemId: string, now = Date.now()): void {
  getDb()
    .prepare(
      `INSERT INTO continue_removed (user_id, item_id, removed_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id, item_id) DO UPDATE SET removed_at = excluded.removed_at`,
    )
    .run(userId, itemId, now);
}

/** item id -> when it was removed. */
export function continueRemovals(userId: string): Map<string, number> {
  return new Map(
    asRows<{ item_id: string; removed_at: number }>(
      getDb().prepare("SELECT item_id, removed_at FROM continue_removed WHERE user_id = ?").all(userId),
    ).map((r) => [r.item_id, r.removed_at]),
  );
}
