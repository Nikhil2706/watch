import "server-only";

import { generateId } from "./crypto";
import { asRow, asRows, getDb } from "./db";
import { createNotification } from "./notifications";
import { ValidationError } from "./validation";

/**
 * Viewer ratings and comments — "Community": what the actual people
 * watching this library think, alongside the external IMDb/RT/Metacritic
 * scores (ratings.ts) and the curator's own accolades (scraping/*).
 *
 * Keyed by IMDb id throughout, same as ratings.ts and every Accolades
 * table — a movie's own id, or a grouped TV show's SERIES id
 * (getGroupSeriesId(), from library-curation.ts), never a Jellyfin item id
 * or one episode's id. The caller (the page rendering a film or a show) is
 * responsible for resolving which imdbId applies before calling into here.
 */

const MAX_COMMENT_CHARS = 2000;

/* ------------------------------------------------------------------ *
 * Ratings
 * ------------------------------------------------------------------ */

export interface RatingSummary {
  average: number | null;
  count: number;
}

export function getRatingSummary(imdbId: string): RatingSummary {
  const row = asRow<{ avg: number | null; n: number }>(
    getDb().prepare("SELECT AVG(score) AS avg, COUNT(*) AS n FROM user_ratings WHERE imdb_id = ?").get(imdbId),
  );
  return { average: row?.avg ?? null, count: row?.n ?? 0 };
}

export function getUserRating(imdbId: string, userId: string): number | null {
  const row = asRow<{ score: number }>(
    getDb().prepare("SELECT score FROM user_ratings WHERE imdb_id = ? AND user_id = ?").get(imdbId, userId),
  );
  return row?.score ?? null;
}

export function upsertRating(imdbId: string, userId: string, score: number): void {
  if (!Number.isInteger(score) || score < 1 || score > 10) {
    throw new ValidationError("Rating must be a whole number from 1 to 10.");
  }
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO user_ratings (id, imdb_id, user_id, score, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(imdb_id, user_id) DO UPDATE SET score = excluded.score, updated_at = excluded.updated_at`,
    )
    .run(generateId(), imdbId, userId, score, now, now);
}

export function deleteRating(imdbId: string, userId: string): void {
  getDb().prepare("DELETE FROM user_ratings WHERE imdb_id = ? AND user_id = ?").run(imdbId, userId);
}

/* ------------------------------------------------------------------ *
 * Comments
 * ------------------------------------------------------------------ */

export interface CommentNode {
  id: string;
  userId: string;
  username: string;
  body: string;
  createdAt: number;
  editedAt: number | null;
  deleted: boolean;
  /** This author's own current rating for the same film (1-10, the DB's half-star scale), or null if they haven't rated it. Not a snapshot — always their latest. */
  rating: number | null;
  replies: CommentNode[];
}

interface CommentRow {
  id: string;
  user_id: string;
  username: string;
  parent_id: string | null;
  body: string;
  created_at: number;
  edited_at: number | null;
  deleted_at: number | null;
  rating: number | null;
}

/** Top-level comments, oldest first, each with its (also oldest-first) replies nested inside. */
export function listComments(imdbId: string): CommentNode[] {
  const rows = asRows<CommentRow>(
    getDb()
      .prepare(
        `SELECT c.id, c.user_id, u.username, c.parent_id, c.body, c.created_at, c.edited_at, c.deleted_at,
                r.score AS rating
           FROM film_comments c
           JOIN users u ON u.id = c.user_id
           LEFT JOIN user_ratings r ON r.user_id = c.user_id AND r.imdb_id = c.imdb_id
          WHERE c.imdb_id = ?
          ORDER BY c.created_at ASC`,
      )
      .all(imdbId),
  );

  const nodes = new Map<string, CommentNode>();
  for (const r of rows) {
    nodes.set(r.id, {
      id: r.id,
      userId: r.user_id,
      username: r.username,
      // A deleted comment's real text is blanked at the DB layer already
      // (see softDeleteComment/adminDeleteComment) — this is defence in
      // depth, not the only guard.
      body: r.deleted_at ? "" : r.body,
      createdAt: r.created_at,
      editedAt: r.edited_at,
      deleted: r.deleted_at !== null,
      rating: r.rating,
      replies: [],
    });
  }

  const topLevel: CommentNode[] = [];
  for (const r of rows) {
    const node = nodes.get(r.id);
    if (!node) continue;
    if (r.parent_id) {
      nodes.get(r.parent_id)?.replies.push(node);
    } else {
      topLevel.push(node);
    }
  }
  return topLevel;
}

export interface AddCommentInput {
  imdbId: string;
  userId: string;
  body: string;
  parentId?: string | null;
  /** Only used to label a reply notification — see notifications.ts for why this isn't looked up server-side. */
  filmTitle: string;
  filmHref: string;
}

/**
 * Posts a top-level comment or a reply. Replies are exactly one level deep
 * — replying to a comment that itself has a parent is rejected, and
 * replying to a deleted comment is rejected (nothing to actually reply
 * to). A reply notifies the parent comment's author, never the replier.
 */
export function addComment(input: AddCommentInput): { id: string } {
  const body = input.body.trim().slice(0, MAX_COMMENT_CHARS);
  if (!body) throw new ValidationError("Comment text is required.");

  let parent: { id: string; userId: string } | null = null;
  if (input.parentId) {
    const row = asRow<{ id: string; parent_id: string | null; user_id: string }>(
      getDb()
        .prepare("SELECT id, parent_id, user_id FROM film_comments WHERE id = ? AND imdb_id = ? AND deleted_at IS NULL")
        .get(input.parentId, input.imdbId),
    );
    if (!row) throw new ValidationError("That comment no longer exists.");
    if (row.parent_id !== null) throw new ValidationError("Replies can only be one level deep.");
    parent = { id: row.id, userId: row.user_id };
  }

  const id = generateId();
  getDb()
    .prepare(
      `INSERT INTO film_comments (id, imdb_id, user_id, parent_id, body, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, input.imdbId, input.userId, parent?.id ?? null, body, Date.now());

  if (parent) {
    createNotification({
      userId: parent.userId,
      actorUserId: input.userId,
      commentId: id,
      imdbId: input.imdbId,
      filmTitle: input.filmTitle,
      filmHref: input.filmHref,
    });
  }

  return { id };
}

/** True only if this comment exists, isn't deleted, and belongs to userId. */
export function editComment(id: string, userId: string, body: string): boolean {
  const clean = body.trim().slice(0, MAX_COMMENT_CHARS);
  if (!clean) throw new ValidationError("Comment text is required.");
  const result = getDb()
    .prepare("UPDATE film_comments SET body = ?, edited_at = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL")
    .run(clean, Date.now(), id, userId);
  return Number(result.changes) > 0;
}

/** Soft delete: the row stays (replies underneath must survive), only its text is cleared. Own comment only. */
export function softDeleteComment(id: string, userId: string): boolean {
  const result = getDb()
    .prepare("UPDATE film_comments SET deleted_at = ?, body = '' WHERE id = ? AND user_id = ? AND deleted_at IS NULL")
    .run(Date.now(), id, userId);
  return Number(result.changes) > 0;
}

/** Curator moderation override — no ownership check, mirrors every other admin route's authority. */
export function adminDeleteComment(id: string): boolean {
  const result = getDb()
    .prepare("UPDATE film_comments SET deleted_at = ?, body = '' WHERE id = ? AND deleted_at IS NULL")
    .run(Date.now(), id);
  return Number(result.changes) > 0;
}
