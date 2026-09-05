import "server-only";

import { generateId } from "./crypto";
import { asRow, asRows, getDb } from "./db";

/**
 * In-app notifications — no push, no email. Seven kinds:
 *  - "reply": someone replied to your comment (has actorUsername + commentId).
 *  - "new_item": a movie was just added to the library (system-generated).
 *  - "curators_pick": the curator flagged a title for you (system-generated —
 *    curator actions are admin-key gated, not tied to a user account, so
 *    there's no "actor" to attribute this to either).
 *  - "new_show": a TV show's first episode(s) went live (system-generated —
 *    see runTvNotifyTick() in library-notify.ts).
 *  - "new_episodes": a TV show you already knew about got more episodes
 *    (same tick, the non-first-sighting case).
 *  - "watch_party_live": a watch party just went live — either an instant
 *    one just now, or a scheduled one whose time arrived
 *    (runPartyScheduleTick()). filmHref points at "/party/{roomId}", not
 *    "/item/{id}" — this is the one kind whose href isn't a film/show page.
 *  - "watch_party_scheduled": a party was just scheduled for later — sent
 *    once, at creation, distinct from watch_party_live's "starts now" ping.
 */
export type NotificationKind =
  | "reply"
  | "new_item"
  | "curators_pick"
  | "new_show"
  | "new_episodes"
  | "watch_party_live"
  | "watch_party_scheduled";

export interface NotificationItem {
  id: string;
  kind: NotificationKind;
  actorUsername: string | null;
  filmTitle: string;
  filmHref: string;
  commentId: string | null;
  episodeCount: number | null;
  createdAt: number;
  read: boolean;
}

export interface NotificationList {
  items: NotificationItem[];
  unreadCount: number;
}

export interface CreateReplyNotificationInput {
  /** Recipient — the comment's original author. */
  userId: string;
  actorUserId: string;
  commentId: string;
  imdbId: string;
  filmTitle: string;
  filmHref: string;
}

/** Never throws, never notifies someone about their own reply to themselves. */
export function createNotification(input: CreateReplyNotificationInput): void {
  if (input.userId === input.actorUserId) return;
  try {
    getDb()
      .prepare(
        `INSERT INTO notifications (id, user_id, kind, actor_user_id, comment_id, imdb_id, film_title, film_href, created_at)
         VALUES (?, ?, 'reply', ?, ?, ?, ?, ?, ?)`,
      )
      .run(generateId(), input.userId, input.actorUserId, input.commentId, input.imdbId, input.filmTitle, input.filmHref, Date.now());
  } catch (error) {
    console.error("[notifications] createNotification failed:", error);
  }
}

export interface SystemNotificationInput {
  kind: "new_item" | "curators_pick" | "new_show" | "new_episodes" | "watch_party_live" | "watch_party_scheduled";
  imdbId: string;
  filmTitle: string;
  filmHref: string;
  /** "new_episodes" only — how many episodes just became visible, for "12 new episodes" phrasing. */
  episodeCount?: number;
  /** "curators_pick" only — why the curator sent it. Never shown in the bell; see getCuratorNote(). */
  note?: string | null;
}

/** Same delivery, for the four system-generated kinds — no actor, no comment. Never throws. */
export function notifyUsers(userIds: string[], input: SystemNotificationInput): number {
  if (userIds.length === 0) return 0;
  const db = getDb();
  const now = Date.now();
  try {
    const insert = db.prepare(
      `INSERT INTO notifications (id, user_id, kind, imdb_id, film_title, film_href, episode_count, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const userId of userIds) {
      insert.run(
        generateId(),
        userId,
        input.kind,
        input.imdbId,
        input.filmTitle,
        input.filmHref,
        input.episodeCount ?? null,
        input.note ?? null,
        now,
      );
    }
    return userIds.length;
  } catch (error) {
    console.error("[notifications] notifyUsers failed:", error);
    return 0;
  }
}

/** Every registered user — used for "new_item" notifications. Never throws. */
export function notifyAllUsers(input: SystemNotificationInput): number {
  try {
    const ids = asRows<{ id: string }>(getDb().prepare("SELECT id FROM users").all()).map((r) => r.id);
    return notifyUsers(ids, input);
  } catch (error) {
    console.error("[notifications] notifyAllUsers failed:", error);
    return 0;
  }
}

/** Most recent first, plus the unread count the bell badge needs — one query round trip for both. */
export function listNotifications(userId: string, limit = 20): NotificationList {
  const db = getDb();
  const rows = asRows<{
    id: string;
    kind: NotificationKind;
    comment_id: string | null;
    film_title: string;
    film_href: string;
    episode_count: number | null;
    created_at: number;
    read_at: number | null;
    actor_username: string | null;
  }>(
    db
      .prepare(
        `SELECT n.id, n.kind, n.comment_id, n.film_title, n.film_href, n.episode_count, n.created_at, n.read_at, u.username AS actor_username
           FROM notifications n
           LEFT JOIN users u ON u.id = n.actor_user_id
          WHERE n.user_id = ?
          ORDER BY n.created_at DESC
          LIMIT ?`,
      )
      .all(userId, limit),
  );
  const unreadCount =
    asRow<{ n: number }>(
      db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL").get(userId),
    )?.n ?? 0;

  return {
    items: rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      actorUsername: r.actor_username,
      filmTitle: r.film_title,
      filmHref: r.film_href,
      commentId: r.comment_id,
      episodeCount: r.episode_count,
      createdAt: r.created_at,
      read: r.read_at !== null,
    })),
    unreadCount,
  };
}

/**
 * Marks one notification, or everything unread, as read — scoped to
 * userId in the WHERE clause itself, not just looked up by id first, so
 * nobody can mark (or probe the existence of) someone else's notification
 * by guessing an id.
 */
export function markNotificationsRead(userId: string, target: { id: string } | { all: true }): void {
  const db = getDb();
  if ("all" in target) {
    db.prepare("UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL").run(Date.now(), userId);
  } else {
    db.prepare("UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ?").run(Date.now(), target.id, userId);
  }
}

/* ------------------------------------------------------------------ *
 * Curator's notes
 *
 * A pick can carry a line explaining why it was sent. It is deliberately
 * absent from the bell — the notification stays one line — and appears in the
 * two places the recommendation actually lives: on the film's own page for the
 * person it was sent to, and on their Picks page.
 *
 * Kept for good rather than expiring. A reason for watching something does not
 * go stale the way an alert does, and an unexpiring note needs no sweeper.
 * ------------------------------------------------------------------ */

export interface CuratorNote {
  note: string;
  sentAt: number;
}

/** The newest note this user was sent about this title, if any. */
export function getCuratorNote(userId: string, imdbId: string): CuratorNote | null {
  const row = asRow<{ note: string; created_at: number }>(
    getDb()
      .prepare(
        `SELECT note, created_at FROM notifications
          WHERE user_id = ? AND imdb_id = ? AND kind = 'curators_pick' AND note IS NOT NULL
          ORDER BY created_at DESC
          LIMIT 1`,
      )
      .get(userId, imdbId),
  );
  return row ? { note: row.note, sentAt: row.created_at } : null;
}

export interface PickedForYou {
  imdbId: string;
  filmTitle: string;
  filmHref: string;
  note: string | null;
  sentAt: number;
}

/**
 * Every film the curator has picked for this person, newest first, one row per
 * title — a film picked twice shows the most recent note rather than appearing
 * twice.
 */
export function listPicksForUser(userId: string, limit = 24): PickedForYou[] {
  const rows = asRows<{
    imdb_id: string;
    film_title: string;
    film_href: string;
    note: string | null;
    created_at: number;
  }>(
    getDb()
      .prepare(
        `SELECT imdb_id, film_title, film_href, note, MAX(created_at) AS created_at
           FROM notifications
          WHERE user_id = ? AND kind = 'curators_pick'
          GROUP BY imdb_id
          ORDER BY created_at DESC
          LIMIT ?`,
      )
      .all(userId, limit),
  );
  return rows.map((r) => ({
    imdbId: r.imdb_id,
    filmTitle: r.film_title,
    filmHref: r.film_href,
    note: r.note,
    sentAt: r.created_at,
  }));
}
