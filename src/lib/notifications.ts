import "server-only";

import { generateId } from "./crypto";
import { asRow, asRows, getDb } from "./db";

/**
 * In-app notifications — no push, no email. Three kinds:
 *  - "reply": someone replied to your comment (has actorUsername + commentId).
 *  - "new_item": a title was just added to the library (system-generated).
 *  - "curators_pick": the curator flagged a title for you (system-generated —
 *    curator actions are admin-key gated, not tied to a user account, so
 *    there's no "actor" to attribute this to either).
 */
export type NotificationKind = "reply" | "new_item" | "curators_pick";

export interface NotificationItem {
  id: string;
  kind: NotificationKind;
  actorUsername: string | null;
  filmTitle: string;
  filmHref: string;
  commentId: string | null;
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
  kind: "new_item" | "curators_pick";
  imdbId: string;
  filmTitle: string;
  filmHref: string;
}

/** Same delivery, for the two system-generated kinds — no actor, no comment. Never throws. */
export function notifyUsers(userIds: string[], input: SystemNotificationInput): number {
  if (userIds.length === 0) return 0;
  const db = getDb();
  const now = Date.now();
  try {
    const insert = db.prepare(
      `INSERT INTO notifications (id, user_id, kind, imdb_id, film_title, film_href, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const userId of userIds) {
      insert.run(generateId(), userId, input.kind, input.imdbId, input.filmTitle, input.filmHref, now);
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
    created_at: number;
    read_at: number | null;
    actor_username: string | null;
  }>(
    db
      .prepare(
        `SELECT n.id, n.kind, n.comment_id, n.film_title, n.film_href, n.created_at, n.read_at, u.username AS actor_username
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
