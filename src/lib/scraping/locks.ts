import "server-only";

import { asRow, getDb } from "../db";
import { sanitizeRichText } from "./rich-text";

/**
 * The curator's override, one row per film. Absence of a row (or of the
 * relevant half of it) means "auto" for that half — blurb and accolade
 * lock independently, so locking one never disturbs the other.
 */

export interface FilmCurationLock {
  imdb_id: string;
  locked_blurb_candidate_id: string | null;
  locked_blurb_text: string | null;
  locked_blurb_source_label: string | null;
  locked_blurb_source_url: string | null;
  locked_accolade_link_id: string | null;
  locked_accolade_entry_id: string | null;
  updated_at: number;
}

export function getLock(imdbId: string): FilmCurationLock | undefined {
  return asRow<FilmCurationLock>(
    getDb().prepare("SELECT * FROM film_curation_locks WHERE imdb_id = ?").get(imdbId),
  );
}

function ensureRow(imdbId: string): void {
  getDb()
    .prepare(
      `INSERT INTO film_curation_locks (imdb_id, updated_at) VALUES (?, ?)
       ON CONFLICT(imdb_id) DO NOTHING`,
    )
    .run(imdbId, Date.now());
}

export function lockBlurbCandidate(imdbId: string, candidateId: string): void {
  ensureRow(imdbId);
  getDb()
    .prepare(
      `UPDATE film_curation_locks
          SET locked_blurb_candidate_id = ?, locked_blurb_text = NULL,
              locked_blurb_source_label = NULL, locked_blurb_source_url = NULL, updated_at = ?
        WHERE imdb_id = ?`,
    )
    .run(candidateId, Date.now(), imdbId);
}

export interface CustomBlurbInput {
  text: string;
  /** e.g. a site the curator copy-pasted a passage from but that isn't scraped — omit for a purely curator-written blurb. */
  sourceLabel?: string | null;
  sourceUrl?: string | null;
}

export function lockCustomBlurb(imdbId: string, input: CustomBlurbInput): void {
  ensureRow(imdbId);
  getDb()
    .prepare(
      `UPDATE film_curation_locks
          SET locked_blurb_candidate_id = NULL, locked_blurb_text = ?,
              locked_blurb_source_label = ?, locked_blurb_source_url = ?, updated_at = ?
        WHERE imdb_id = ?`,
    )
    .run(sanitizeRichText(input.text), input.sourceLabel ?? null, input.sourceUrl ?? null, Date.now(), imdbId);
}

export function unlockBlurb(imdbId: string): void {
  getDb()
    .prepare(
      `UPDATE film_curation_locks
          SET locked_blurb_candidate_id = NULL, locked_blurb_text = NULL,
              locked_blurb_source_label = NULL, locked_blurb_source_url = NULL, updated_at = ?
        WHERE imdb_id = ?`,
    )
    .run(Date.now(), imdbId);
}

export function lockAccoladeLink(imdbId: string, linkId: string): void {
  ensureRow(imdbId);
  getDb()
    .prepare(
      `UPDATE film_curation_locks
          SET locked_accolade_link_id = ?, locked_accolade_entry_id = NULL, updated_at = ?
        WHERE imdb_id = ?`,
    )
    .run(linkId, Date.now(), imdbId);
}

export function lockAccoladeEntry(imdbId: string, entryId: string): void {
  ensureRow(imdbId);
  getDb()
    .prepare(
      `UPDATE film_curation_locks
          SET locked_accolade_link_id = NULL, locked_accolade_entry_id = ?, updated_at = ?
        WHERE imdb_id = ?`,
    )
    .run(entryId, Date.now(), imdbId);
}

export function unlockAccolade(imdbId: string): void {
  getDb()
    .prepare(
      `UPDATE film_curation_locks
          SET locked_accolade_link_id = NULL, locked_accolade_entry_id = NULL, updated_at = ?
        WHERE imdb_id = ?`,
    )
    .run(Date.now(), imdbId);
}
