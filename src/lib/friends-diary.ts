import "server-only";

import { asRows, getDb } from "./db";
import { diaryEntries, type DiaryEntry } from "./diary";
import { friendsSharingWith, type Friend } from "./friends";
import { getGroupedPathMap } from "./library-curation";
import { getAllMovies, type MediaItem } from "./media";
import type { ResolvedSession } from "./session";

/**
 * Friends' diaries: /friends (who shares, how much, what last) and
 * /friends/{name} (everything they have finished). Only friends who share
 * their activity (friends.ts, the same rule as Home's friends rows), and only
 * titles the viewer could open themselves.
 */

/** Far more than anyone here has finished; the page says so if it's reached. */
export const DIARY_LIMIT = 2000;

export interface FriendSummary {
  friend: Friend;
  finished: number;
  lastTitle: string | null;
  lastAt: number | null;
}

export function friendsOverview(viewerId: string): FriendSummary[] {
  const friends = friendsSharingWith(viewerId);
  if (!friends.length) return [];
  const db = getDb();
  return friends
    .map((friend) => {
      const [stats] = asRows<{ n: number; last_at: number | null }>(
        db.prepare("SELECT COUNT(*) AS n, MAX(watched_at) AS last_at FROM watch_log WHERE user_id = ?").all(friend.id),
      );
      const [last] = asRows<{ title: string | null }>(
        db.prepare("SELECT title FROM watch_log WHERE user_id = ? ORDER BY watched_at DESC LIMIT 1").all(friend.id),
      );
      return { friend, finished: stats?.n ?? 0, lastTitle: last?.title ?? null, lastAt: stats?.last_at ?? null };
    })
    .sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0) || a.friend.username.localeCompare(b.friend.username));
}

export interface FriendDiary {
  friend: Friend;
  entries: Array<{ entry: DiaryEntry; item: MediaItem }>;
  /** Finishes of titles this viewer can't open (hidden, parental control, removed): counted, not shown. */
  notShown: number;
  /** The log holds more than DIARY_LIMIT. */
  truncated: boolean;
}

/** Null when there's no such friend, or they don't share their activity with this viewer. */
export async function friendDiary(session: ResolvedSession, username: string): Promise<FriendDiary | null> {
  const friend = friendsSharingWith(session.userId).find((f) => f.username.toLowerCase() === username.toLowerCase());
  if (!friend) return null;
  return { friend, ...(await userDiary(session, friend.id)) };
}

export type UserDiary = Omit<FriendDiary, "friend">;

/**
 * Anyone's diary, seen through `session`'s own listing: a friend's (above),
 * or the viewer's own, which History shows in its Diary view. Whose it is
 * must already be allowed by the caller.
 */
export async function userDiary(session: ResolvedSession, userId: string): Promise<UserDiary> {
  const db = getDb();

  const rows = asRows<{ item_id: string; imdb_id: string | null; path: string | null; watched_at: number }>(
    db
      .prepare("SELECT item_id, imdb_id, path, watched_at FROM watch_log WHERE user_id = ? ORDER BY watched_at DESC LIMIT ?")
      .all(userId, DIARY_LIMIT + 1),
  );
  const truncated = rows.length > DIARY_LIMIT;
  const log = rows.slice(0, DIARY_LIMIT);

  const ratings = new Map(
    asRows<{ imdb_id: string; score: number }>(
      db.prepare("SELECT imdb_id, score FROM user_ratings WHERE user_id = ?").all(userId),
    ).map((r) => [r.imdb_id, r.score]),
  );
  // The latest review of each title: rows come oldest first, so later ones win.
  const reviews = new Map(
    asRows<{ imdb_id: string; body: string }>(
      db
        .prepare(
          `SELECT imdb_id, body FROM film_comments
           WHERE user_id = ? AND parent_id IS NULL AND deleted_at IS NULL ORDER BY created_at`,
        )
        .all(userId),
    ).map((r) => [r.imdb_id, r.body]),
  );

  // An episode's rating and review are the show's, kept under its series id.
  const showOfPath = getGroupedPathMap();
  const seriesImdb = new Map(
    asRows<{ group_id: string; imdb_id: string }>(db.prepare("SELECT group_id, imdb_id FROM library_group_series").all()).map(
      (r) => [r.group_id, r.imdb_id],
    ),
  );
  const pathOf = new Map(log.map((r) => [r.item_id, r.path]));
  const entries = diaryEntries(
    log.map((r) => ({ itemId: r.item_id, imdbId: r.imdb_id, watchedAt: r.watched_at })),
    ratings,
    reviews,
    (row) => {
      const path = pathOf.get(row.itemId);
      const show = path ? showOfPath.get(path) : undefined;
      return (show && seriesImdb.get(show.groupId)) ?? row.imdbId;
    },
  );

  const byId = new Map((await getAllMovies(session, { limit: 2000 })).map((i) => [i.Id, i]));
  const shown: UserDiary["entries"] = [];
  let notShown = 0;
  for (const entry of entries) {
    const item = byId.get(entry.itemId);
    if (item) shown.push({ entry, item });
    else notShown += 1;
  }
  return { entries: shown, notShown, truncated };
}
