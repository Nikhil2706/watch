import "server-only";

import { asRow, asRows, getDb } from "./db";
import { accoladeMentionsForFilm, blurbCandidatesForFilm } from "./scraping/articles";
import { curatorAccoladeMentionsForFilm } from "./scraping/curator-accolades";
import { looksLikeWikiMarkup } from "./scraping/wiki-markup";

/**
 * Which blurb and which accolade a film is showing right now, when the
 * curator has not locked one.
 *
 * Before this, an unlocked blurb was drawn at random on every page load and
 * an unlocked accolade was always the film's best placing. Neither can be
 * "rotated every Thursday": there was nothing held to rotate. A row here is
 * that held choice. A scheduled job moves it on; resolve.ts reads it; and a
 * film with no row behaves exactly as it did before, so nothing changes until
 * a rotation job first runs.
 *
 * A curator's lock (locks.ts) always wins and is never touched by a rotation.
 */

export interface FilmRotation {
  imdb_id: string;
  blurb_candidate_id: string | null;
  /** "link:{article_film_links.id}" or "entry:{curator_accolade_entries.id}". */
  accolade_ref: string | null;
  blurb_at: number | null;
  accolade_at: number | null;
}

export function getRotation(imdbId: string): FilmRotation | undefined {
  return asRow<FilmRotation>(getDb().prepare("SELECT * FROM film_rotation WHERE imdb_id = ?").get(imdbId));
}

function filmsWithMaterial(): string[] {
  return asRows<{ imdb_id: string }>(
    getDb()
      .prepare(
        `SELECT imdb_id FROM article_film_links WHERE imdb_id IS NOT NULL
         UNION
         SELECT imdb_id FROM curator_accolade_entries WHERE imdb_id IS NOT NULL`,
      )
      .all(),
  ).map((r) => r.imdb_id);
}

export interface RotationResult {
  films: number;
  changed: number;
}

/**
 * Gives every film with passages a blurb to show until the next rotation,
 * different from the one it has now wherever it has more than one.
 */
export function rotateBlurbs(now: number = Date.now()): RotationResult {
  const write = getDb().prepare(
    `INSERT INTO film_rotation (imdb_id, blurb_candidate_id, blurb_at) VALUES (?, ?, ?)
     ON CONFLICT(imdb_id) DO UPDATE SET blurb_candidate_id = excluded.blurb_candidate_id, blurb_at = excluded.blurb_at`,
  );
  let films = 0;
  let changed = 0;
  for (const imdbId of filmsWithMaterial()) {
    const candidates = blurbCandidatesForFilm(imdbId).filter((c) => !looksLikeWikiMarkup(c.passage_text));
    if (candidates.length === 0) continue;
    films++;
    const current = getRotation(imdbId)?.blurb_candidate_id ?? null;
    const others = candidates.filter((c) => c.id !== current);
    const pool = others.length > 0 ? others : candidates;
    const next = pool[Math.floor(Math.random() * pool.length)]!;
    if (next.id !== current) changed++;
    write.run(imdbId, next.id, now);
  }
  return { films, changed };
}

/** Every accolade a film has, in one stable order: wins, then placings best first, then the curator's own lists. */
export function accoladeRefsForFilm(imdbId: string): string[] {
  return [
    ...accoladeMentionsForFilm(imdbId).map((m) => `link:${m.id}`),
    ...curatorAccoladeMentionsForFilm(imdbId).map((e) => `entry:${e.id}`),
  ];
}

/**
 * Moves each film on to its next accolade, wrapping round. A film with one
 * accolade keeps it; a film with several shows each in turn rather than only
 * ever its best placing.
 */
export function rotateAccolades(now: number = Date.now()): RotationResult {
  const write = getDb().prepare(
    `INSERT INTO film_rotation (imdb_id, accolade_ref, accolade_at) VALUES (?, ?, ?)
     ON CONFLICT(imdb_id) DO UPDATE SET accolade_ref = excluded.accolade_ref, accolade_at = excluded.accolade_at`,
  );
  let films = 0;
  let changed = 0;
  for (const imdbId of filmsWithMaterial()) {
    const refs = accoladeRefsForFilm(imdbId);
    if (refs.length === 0) continue;
    films++;
    const current = getRotation(imdbId)?.accolade_ref ?? null;
    const at = current ? refs.indexOf(current) : -1;
    const next = refs[(at + 1) % refs.length]!;
    if (next !== current) changed++;
    write.run(imdbId, next, now);
  }
  return { films, changed };
}
