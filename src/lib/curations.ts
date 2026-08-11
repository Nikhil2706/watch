import "server-only";

import { generateId } from "./crypto";
import { asRows, getDb } from "./db";

/**
 * Curator's Picks — articles and essays the admin attaches, with his own note.
 *
 * The comment and the curator's name are the point of the feature, not
 * decoration: a bare link is a bookmark, whereas "watch this after the film,
 * it explains the ending — Mamnani" is a recommendation. Both are shown on the
 * card rather than hidden behind a click.
 */

export type CurationKind = "article" | "essay" | "video" | "note";

export const CURATION_KINDS: readonly CurationKind[] = ["article", "essay", "video", "note"];

export function isCurationKind(value: unknown): value is CurationKind {
  return typeof value === "string" && (CURATION_KINDS as readonly string[]).includes(value);
}

export interface Curation {
  id: string;
  jellyfin_item_id: string | null;
  kind: CurationKind;
  title: string;
  url: string | null;
  comment: string | null;
  curator: string;
  position: number;
  created_at: number;
}

export function createCuration(input: {
  itemId?: string | null;
  kind: CurationKind;
  title: string;
  url?: string | null;
  comment?: string | null;
  curator: string;
  position?: number;
}): Curation {
  const id = generateId();
  const now = Date.now();

  getDb()
    .prepare(
      `INSERT INTO curations (id, jellyfin_item_id, kind, title, url, comment, curator, position, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.itemId ?? null,
      input.kind,
      input.title,
      input.url ?? null,
      input.comment ?? null,
      input.curator,
      input.position ?? 0,
      now,
    );

  return {
    id,
    jellyfin_item_id: input.itemId ?? null,
    kind: input.kind,
    title: input.title,
    url: input.url ?? null,
    comment: input.comment ?? null,
    curator: input.curator,
    position: input.position ?? 0,
    created_at: now,
  };
}

/** Ordered by explicit position, then newest first. */
export function listCurations(limit = 50): Curation[] {
  return asRows<Curation>(
    getDb()
      .prepare("SELECT * FROM curations ORDER BY position DESC, created_at DESC LIMIT ?")
      .all(limit),
  );
}

/** Picks attached to one film, for its detail page. */
export function curationsForItem(itemId: string): Curation[] {
  return asRows<Curation>(
    getDb()
      .prepare(
        `SELECT * FROM curations WHERE jellyfin_item_id = ?
          ORDER BY position DESC, created_at DESC`,
      )
      .all(itemId),
  );
}

export function deleteCuration(id: string): boolean {
  const result = getDb().prepare("DELETE FROM curations WHERE id = ?").run(id);
  return Number(result.changes) > 0;
}
