import "server-only";

import { asRow, asRows, getDb } from "./db";
import { env } from "./env";
import { maySeeActivity, parseVisibility, type ActivityVisibility } from "./friends-feed";

/**
 * Friends, and who may see whose activity (friends-feed.ts has the rule).
 *
 * On this site everyone is everyone's friend (EVERYONE_IS_FRIENDS, on by
 * default): a handful of people who all know each other. For a bigger site,
 * turn that off and the friendships table decides; there is no screen for
 * making friends yet, because nobody here needs one.
 */

export function activityVisibility(userId: string): ActivityVisibility {
  const row = asRow<{ activity_visibility: string }>(
    getDb().prepare("SELECT activity_visibility FROM users WHERE id = ?").get(userId),
  );
  return parseVisibility(row?.activity_visibility);
}

export function setActivityVisibility(userId: string, visibility: ActivityVisibility): void {
  getDb().prepare("UPDATE users SET activity_visibility = ? WHERE id = ?").run(visibility, userId);
}

export function areFriends(a: string, b: string): boolean {
  if (a === b) return false;
  if (env.everyoneIsFriends) return true;
  const row = asRow<{ n: number }>(
    getDb()
      .prepare(
        `SELECT COUNT(*) AS n FROM friendships
         WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)`,
      )
      .get(a, b, b, a),
  );
  return (row?.n ?? 0) === 2;
}

export interface Friend {
  id: string;
  username: string;
  jellyfinUserId: string;
}

/** The people whose activity `viewerId` may see: friends who share it, not suspended, not themself. */
export function friendsSharingWith(viewerId: string): Friend[] {
  const users = asRows<{ id: string; username: string; jellyfin_user_id: string; activity_visibility: string }>(
    getDb()
      .prepare("SELECT id, username, jellyfin_user_id, activity_visibility FROM users WHERE suspended = 0")
      .all(),
  );
  return users
    .filter((u) =>
      maySeeActivity({
        viewerId,
        ownerId: u.id,
        ownerVisibility: parseVisibility(u.activity_visibility),
        friends: areFriends(viewerId, u.id),
      }),
    )
    .map((u) => ({ id: u.id, username: u.username, jellyfinUserId: u.jellyfin_user_id }));
}
