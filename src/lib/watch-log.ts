import "server-only";

import { generateId } from "./crypto";
import { asRows, getDb } from "./db";
import { listPlayedForUser } from "./jellyfin";

/**
 * The watch log (v63): every finish, per person, copied from Jellyfin.
 *
 * Jellyfin records only the last time each viewer played an item, so a
 * rewatch overwrites the first watch. Copying each (item, LastPlayedDate) as
 * it appears keeps both. The first sync after deploy backfills each person's
 * recent history (Jellyfin's dates for what they have already finished), so
 * friends' activity has something in it from the start.
 */

/** Each person's most recent finishes read per sync: far more than anyone finishes between syncs. */
const PER_USER = 60;

export async function syncWatchLog(): Promise<{ users: number; added: number }> {
  const users = asRows<{ id: string; jellyfin_user_id: string }>(
    getDb().prepare("SELECT id, jellyfin_user_id FROM users WHERE suspended = 0").all(),
  );
  const insert = getDb().prepare(
    `INSERT OR IGNORE INTO watch_log (id, user_id, item_id, imdb_id, path, title, watched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  let added = 0;
  for (const user of users) {
    let played;
    try {
      played = await listPlayedForUser(user.jellyfin_user_id, PER_USER);
    } catch (error) {
      // An account Jellyfin no longer has, or a moment of Jellyfin being away.
      console.warn(`[watch-log] could not read ${user.id}'s history:`, error instanceof Error ? error.message : error);
      continue;
    }
    for (const item of played) {
      const at = Date.parse(item.UserData?.LastPlayedDate ?? "");
      if (!Number.isFinite(at)) continue;
      const result = insert.run(
        generateId(),
        user.id,
        item.Id,
        item.ProviderIds?.Imdb ?? null,
        item.Path ?? null,
        item.Name ?? null,
        at,
      );
      added += Number(result.changes);
    }
  }
  return { users: users.length, added };
}
