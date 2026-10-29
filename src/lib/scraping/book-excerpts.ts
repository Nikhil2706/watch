import "server-only";

import { getDb } from "../db";

/**
 * The excerpt the curator chose from an uploaded book about a film, for its
 * "Read more" when it ends (book_excerpts in schema.ts, readingFor in
 * articles.ts).
 *
 * BOOK_EXCERPT_MAX keeps it an excerpt: a few paragraphs, about 250 words.
 * The book's full text stays where it always was, read only in the console.
 */
export const BOOK_EXCERPT_MAX = 1500;

export class BookExcerptTooLong extends Error {}

export function setBookExcerpt(imdbId: string, articleId: string, text: string): void {
  const excerpt = text.trim();
  if (excerpt.length > BOOK_EXCERPT_MAX) {
    throw new BookExcerptTooLong(`An excerpt can be up to ${BOOK_EXCERPT_MAX} characters; this is ${excerpt.length}.`);
  }
  getDb()
    .prepare(
      `INSERT INTO book_excerpts (imdb_id, article_id, text, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(imdb_id, article_id) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at`,
    )
    .run(imdbId, articleId, excerpt, Date.now());
}

export function clearBookExcerpt(imdbId: string, articleId: string): void {
  getDb().prepare("DELETE FROM book_excerpts WHERE imdb_id = ? AND article_id = ?").run(imdbId, articleId);
}
