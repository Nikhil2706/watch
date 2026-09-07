import "server-only";

import { generateId } from "../crypto";
import { insertAt, moveByOne, moveTo, removeFrom, slotChanges } from "../accolade-order";
import { asRow, asRows, getDb, transaction } from "../db";
import { sanitizeRichText } from "./rich-text";

/**
 * The curator's own ranked lists / award-style mentions — independent of
 * anything scraped, e.g. "Mamnani's Favourite Car Movies". Same not-yet-
 * in-library support as a scraped mention: imdb_id is null until matched,
 * re-resolved on every library scan.
 */

export interface CuratorAccolade {
  id: string;
  name: string;
  created_at: number;
  updated_at: number;
}

export interface CuratorAccoladeEntry {
  id: string;
  accolade_id: string;
  slot: number;
  imdb_id: string | null;
  raw_title: string;
  raw_year: number | null;
  blurb_text: string | null;
  created_at: number;
}

export function listCuratorAccolades(): CuratorAccolade[] {
  return asRows<CuratorAccolade>(
    getDb().prepare("SELECT * FROM curator_accolades ORDER BY updated_at DESC").all(),
  );
}

export function createCuratorAccolade(name: string): CuratorAccolade {
  const id = generateId();
  const now = Date.now();
  getDb()
    .prepare("INSERT INTO curator_accolades (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .run(id, name, now, now);
  return { id, name, created_at: now, updated_at: now };
}

export function renameCuratorAccolade(id: string, name: string): void {
  getDb()
    .prepare("UPDATE curator_accolades SET name = ?, updated_at = ? WHERE id = ?")
    .run(name, Date.now(), id);
}

export function deleteCuratorAccolade(id: string): boolean {
  const result = getDb().prepare("DELETE FROM curator_accolades WHERE id = ?").run(id);
  return Number(result.changes) > 0;
}

export function listCuratorAccoladeEntries(accoladeId: string): CuratorAccoladeEntry[] {
  return asRows<CuratorAccoladeEntry>(
    getDb()
      .prepare("SELECT * FROM curator_accolade_entries WHERE accolade_id = ? ORDER BY slot ASC")
      .all(accoladeId),
  );
}

/** matchTitle() resolution happens at the call site (dashboard route), which already knows imdbId or null. */
export function upsertCuratorAccoladeEntry(input: {
  accoladeId: string;
  slot: number;
  imdbId: string | null;
  rawTitle: string;
  rawYear: number | null;
  blurbText?: string | null;
}): CuratorAccoladeEntry {
  const existing = asRow<{ id: string }>(
    getDb()
      .prepare("SELECT id FROM curator_accolade_entries WHERE accolade_id = ? AND slot = ?")
      .get(input.accoladeId, input.slot),
  );
  const id = existing?.id ?? generateId();
  const now = Date.now();
  const blurbText = input.blurbText ? sanitizeRichText(input.blurbText) : null;

  if (existing) {
    getDb()
      .prepare(
        `UPDATE curator_accolade_entries SET imdb_id = ?, raw_title = ?, raw_year = ?, blurb_text = ? WHERE id = ?`,
      )
      .run(input.imdbId, input.rawTitle, input.rawYear, blurbText, id);
  } else {
    getDb()
      .prepare(
        `INSERT INTO curator_accolade_entries (id, accolade_id, slot, imdb_id, raw_title, raw_year, blurb_text, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.accoladeId, input.slot, input.imdbId, input.rawTitle, input.rawYear, blurbText, now);
  }
  getDb().prepare("UPDATE curator_accolades SET updated_at = ? WHERE id = ?").run(now, input.accoladeId);

  return {
    id,
    accolade_id: input.accoladeId,
    slot: input.slot,
    imdb_id: input.imdbId,
    raw_title: input.rawTitle,
    raw_year: input.rawYear,
    blurb_text: blurbText,
    created_at: now,
  };
}

/**
 * Applies an ordering to the stored slots, writing only what moved.
 *
 * Every reordering operation funnels through here so the dense zero-based
 * invariant has exactly one place it can be broken.
 */
function applyOrder(accoladeId: string, orderedIds: string[]): void {
  const current = new Map(
    asRows<{ id: string; slot: number }>(
      getDb()
        .prepare("SELECT id, slot FROM curator_accolade_entries WHERE accolade_id = ?")
        .all(accoladeId),
    ).map((r) => [r.id, r.slot]),
  );

  const changes = slotChanges(orderedIds, current);
  if (changes.length === 0) return;

  transaction((db) => {
    // Two passes through a negative staging range. Nothing constrains slot to
    // be unique, but a single pass can still transiently put two entries on the
    // same slot, and anything reading mid-write would see a duplicate rank.
    for (const c of changes) {
      db.prepare("UPDATE curator_accolade_entries SET slot = ? WHERE id = ?").run(-1 - c.slot, c.id);
    }
    for (const c of changes) {
      db.prepare("UPDATE curator_accolade_entries SET slot = ? WHERE id = ?").run(c.slot, c.id);
    }
    db.prepare("UPDATE curator_accolades SET updated_at = ? WHERE id = ?").run(Date.now(), accoladeId);
  });
}

function orderedIdsOf(accoladeId: string): string[] {
  return asRows<{ id: string }>(
    getDb()
      .prepare("SELECT id FROM curator_accolade_entries WHERE accolade_id = ? ORDER BY slot ASC")
      .all(accoladeId),
  ).map((r) => r.id);
}

/**
 * Removes an entry and closes the gap behind it.
 *
 * The gap-closing is the point. Slots used to be left holed, and the console
 * derives the next slot from its row count — so deleting a middle entry and
 * then adding one computed a slot that collided with the last entry, and
 * upsert silently overwrote it. A list that loses a film every time you add
 * one is not a list you can keep for a year.
 */
export function deleteCuratorAccoladeEntry(id: string): boolean {
  const row = asRow<{ accolade_id: string }>(
    getDb().prepare("SELECT accolade_id FROM curator_accolade_entries WHERE id = ?").get(id),
  );
  if (!row) return false;

  const remaining = removeFrom(orderedIdsOf(row.accolade_id), id);
  const result = getDb().prepare("DELETE FROM curator_accolade_entries WHERE id = ?").run(id);
  if (Number(result.changes) === 0) return false;

  applyOrder(row.accolade_id, remaining);
  return true;
}

/** Nudge one row past its neighbour — what the up/down arrows do. */
export function moveCuratorAccoladeEntry(
  accoladeId: string,
  entryId: string,
  direction: "up" | "down",
): boolean {
  const ids = orderedIdsOf(accoladeId);
  if (!ids.includes(entryId)) return false;
  applyOrder(accoladeId, moveByOne(ids, entryId, direction));
  return true;
}

/**
 * Move an entry to an absolute rank.
 *
 * A pairwise swap cannot say "this is now number one" in fewer than nine steps
 * from the bottom of a ten-film list, which is the move a year-end list
 * actually needs as the year turns.
 */
export function moveCuratorAccoladeEntryTo(
  accoladeId: string,
  entryId: string,
  position: number,
): boolean {
  const ids = orderedIdsOf(accoladeId);
  if (!ids.includes(entryId)) return false;
  applyOrder(accoladeId, moveTo(ids, entryId, position));
  return true;
}

/**
 * Insert a new film at a rank, pushing everything at or below it down.
 *
 * Distinct from upsertCuratorAccoladeEntry(), which overwrites whatever holds
 * that slot. Both are wanted: replacing the film at number three is a different
 * act from a new film entering at number three.
 */
export function insertCuratorAccoladeEntry(input: {
  accoladeId: string;
  position: number;
  imdbId: string | null;
  rawTitle: string;
  rawYear: number | null;
  blurbText?: string | null;
}): CuratorAccoladeEntry {
  const ids = orderedIdsOf(input.accoladeId);
  const clamped = Math.max(0, Math.min(Math.floor(input.position), ids.length));

  // Appended at the end first, then moved into place, so the new row never
  // shares a slot with an existing one even for an instant.
  const entry = upsertCuratorAccoladeEntry({
    accoladeId: input.accoladeId,
    slot: ids.length,
    imdbId: input.imdbId,
    rawTitle: input.rawTitle,
    rawYear: input.rawYear,
    blurbText: input.blurbText,
  });

  applyOrder(input.accoladeId, insertAt([...ids, entry.id], entry.id, clamped));
  return { ...entry, slot: clamped };
}

/**
 * Repairs a list whose slots are not dense — from data written before removal
 * closed the gap. Safe to call on a healthy list, where it writes nothing.
 */
export function normaliseCuratorAccoladeSlots(accoladeId: string): void {
  applyOrder(accoladeId, orderedIdsOf(accoladeId));
}

export interface CuratorAccoladeMention extends CuratorAccoladeEntry {
  accolade_name: string;
}

/** Every curator-built list a film appears in — the "auto" read path considers these alongside scraped accolade_rank/accolade_label mentions. */
export function curatorAccoladeMentionsForFilm(imdbId: string): CuratorAccoladeMention[] {
  return asRows<CuratorAccoladeMention>(
    getDb()
      .prepare(
        `SELECT e.*, a.name AS accolade_name
           FROM curator_accolade_entries e
           JOIN curator_accolades a ON a.id = e.accolade_id
          WHERE e.imdb_id = ?
          ORDER BY e.slot ASC`,
      )
      .all(imdbId),
  );
}

export function getCuratorAccoladeEntry(id: string): CuratorAccoladeMention | undefined {
  return asRow<CuratorAccoladeMention>(
    getDb()
      .prepare(
        `SELECT e.*, a.name AS accolade_name FROM curator_accolade_entries e
           JOIN curator_accolades a ON a.id = e.accolade_id WHERE e.id = ?`,
      )
      .get(id),
  );
}
