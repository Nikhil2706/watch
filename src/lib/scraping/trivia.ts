import "server-only";

import { generateId } from "../crypto";
import { asRow, asRows, getDb } from "../db";
import { sanitizeRichText } from "./rich-text";
import { triviaCandidatesForFilm } from "./articles";

/**
 * Trivia is a LIST, not a single locked pick like the blurb — a film
 * reasonably carries several facts at once. Any row in film_trivia_
 * selections for an imdb_id means "curated": show exactly those, in
 * position order. No rows means "auto": up to 5 random candidates from
 * whatever's been scraped/uploaded about that film.
 */

export interface TriviaFact {
  id: string;
  text: string;
  sourceLabel: string;
  sourceUrl: string | null;
  custom: boolean;
}

interface SelectionRow {
  id: string;
  custom_text: string | null;
  position: number;
  fact_text: string | null;
  article_title: string | null;
  article_url: string | null;
  source_name: string | null;
}

export function listTriviaSelections(imdbId: string): TriviaFact[] {
  return asRows<SelectionRow>(
    getDb()
      .prepare(
        `SELECT s.id, s.custom_text, s.position,
                tc.fact_text, a.title AS article_title, a.url AS article_url, src.name AS source_name
           FROM film_trivia_selections s
           LEFT JOIN article_trivia_candidates tc ON tc.id = s.trivia_candidate_id
           LEFT JOIN article_film_links l ON l.id = tc.link_id
           LEFT JOIN scraped_articles a ON a.id = l.article_id
           LEFT JOIN scrape_sources src ON src.id = a.source_id
          WHERE s.imdb_id = ?
          ORDER BY s.position ASC`,
      )
      .all(imdbId),
  ).map((row) => ({
    id: row.id,
    text: row.custom_text ?? row.fact_text ?? "",
    sourceLabel: row.custom_text ? "Curator" : (row.source_name ?? row.article_title ?? "Unknown source"),
    sourceUrl: row.custom_text ? null : row.article_url,
    custom: row.custom_text !== null,
  }));
}

/** Adds a scraped/uploaded candidate to a film's curated trivia list, at the end. */
export function addTriviaCandidateSelection(imdbId: string, triviaCandidateId: string): void {
  const position = nextPosition(imdbId);
  getDb()
    .prepare(
      `INSERT INTO film_trivia_selections (id, imdb_id, trivia_candidate_id, custom_text, position, created_at)
       VALUES (?, ?, ?, NULL, ?, ?)`,
    )
    .run(generateId(), imdbId, triviaCandidateId, position, Date.now());
}

/** Adds a curator-typed fact to a film's curated trivia list, at the end. */
export function addCustomTriviaSelection(imdbId: string, text: string): void {
  const position = nextPosition(imdbId);
  getDb()
    .prepare(
      `INSERT INTO film_trivia_selections (id, imdb_id, trivia_candidate_id, custom_text, position, created_at)
       VALUES (?, ?, NULL, ?, ?, ?)`,
    )
    .run(generateId(), imdbId, sanitizeRichText(text), position, Date.now());
}

export function removeTriviaSelection(id: string): boolean {
  const result = getDb().prepare("DELETE FROM film_trivia_selections WHERE id = ?").run(id);
  return Number(result.changes) > 0;
}

/** Only a curator-typed fact can be edited in place — a candidate-sourced fact reflects the source's own text; to change that, remove it and add a custom one instead. */
export function editCustomTriviaSelection(id: string, text: string): boolean {
  const result = getDb()
    .prepare("UPDATE film_trivia_selections SET custom_text = ? WHERE id = ? AND custom_text IS NOT NULL")
    .run(sanitizeRichText(text), id);
  return Number(result.changes) > 0;
}

/** Swaps this selection's position with its neighbour — the whole list stays a dense 0..n-1 sequence, so no renumbering pass is ever needed. */
export function moveTriviaSelection(imdbId: string, id: string, direction: "up" | "down"): boolean {
  const rows = asRows<{ id: string; position: number }>(
    getDb()
      .prepare("SELECT id, position FROM film_trivia_selections WHERE imdb_id = ? ORDER BY position ASC")
      .all(imdbId),
  );
  const idx = rows.findIndex((r) => r.id === id);
  if (idx === -1) return false;
  const swapIdx = direction === "up" ? idx - 1 : idx + 1;
  if (swapIdx < 0 || swapIdx >= rows.length) return false;

  const a = rows[idx]!;
  const b = rows[swapIdx]!;
  const db = getDb();
  db.prepare("UPDATE film_trivia_selections SET position = ? WHERE id = ?").run(b.position, a.id);
  db.prepare("UPDATE film_trivia_selections SET position = ? WHERE id = ?").run(a.position, b.id);
  return true;
}

function nextPosition(imdbId: string): number {
  const row = asRow<{ max_position: number | null }>(
    getDb()
      .prepare("SELECT MAX(position) AS max_position FROM film_trivia_selections WHERE imdb_id = ?")
      .get(imdbId),
  );
  return (row?.max_position ?? -1) + 1;
}

/** Public read path: curated list if the curator has picked one, else up to 5 random candidates. Never returns full article text. */
export function resolveTriviaForFilm(imdbId: string, randomLimit = 5): TriviaFact[] {
  const curated = listTriviaSelections(imdbId);
  if (curated.length > 0) return curated;

  const candidates = triviaCandidatesForFilm(imdbId);
  if (candidates.length === 0) return [];

  return shuffle(candidates)
    .slice(0, randomLimit)
    .map((c) => ({
      id: c.id,
      text: c.fact_text,
      sourceLabel: c.article_title,
      sourceUrl: null,
      custom: false,
    }));
}

function shuffle<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const temp = copy[i]!;
    copy[i] = copy[j]!;
    copy[j] = temp;
  }
  return copy;
}
