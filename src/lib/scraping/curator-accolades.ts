import "server-only";

import { generateId } from "../crypto";
import { asRow, asRows, getDb } from "../db";
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

export function deleteCuratorAccoladeEntry(id: string): boolean {
  const result = getDb().prepare("DELETE FROM curator_accolade_entries WHERE id = ?").run(id);
  return Number(result.changes) > 0;
}

/** Swaps this slot's position with its neighbour — same reasoning as trivia's moveTriviaSelection: a pairwise swap never needs a renumbering pass. */
export function moveCuratorAccoladeEntry(accoladeId: string, entryId: string, direction: "up" | "down"): boolean {
  const rows = asRows<{ id: string; slot: number }>(
    getDb()
      .prepare("SELECT id, slot FROM curator_accolade_entries WHERE accolade_id = ? ORDER BY slot ASC")
      .all(accoladeId),
  );
  const idx = rows.findIndex((r) => r.id === entryId);
  if (idx === -1) return false;
  const swapIdx = direction === "up" ? idx - 1 : idx + 1;
  if (swapIdx < 0 || swapIdx >= rows.length) return false;

  const a = rows[idx]!;
  const b = rows[swapIdx]!;
  const db = getDb();
  db.prepare("UPDATE curator_accolade_entries SET slot = ? WHERE id = ?").run(b.slot, a.id);
  db.prepare("UPDATE curator_accolade_entries SET slot = ? WHERE id = ?").run(a.slot, b.id);
  db.prepare("UPDATE curator_accolades SET updated_at = ? WHERE id = ?").run(Date.now(), accoladeId);
  return true;
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
