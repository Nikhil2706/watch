import "server-only";

import { asRows, getDb } from "./db";

/**
 * Which of TMDB's suggestions for a film are actually on this disk.
 *
 * Two SQL reads and no network: the film's own payload carries its
 * recommendations and similar lists, and tmdb_links already says which TMDB
 * ids this library owns. The intersection is what "More like this" can use —
 * see similar-rank.ts for the measurement that made this an endorsement signal
 * rather than a source of tiles.
 *
 * Returns IMDb ids rather than TMDB ids because that is the identifier the
 * Jellyfin side of the row speaks: item.ProviderIds.Imdb is what a similar
 * item can be matched on without another round trip.
 */

interface SuggestionPayload {
  recommendations?: { results?: Array<{ id: number }> };
  similar?: { results?: Array<{ id: number }> };
}

export interface TmdbSuggestions {
  /** IMDb ids of owned films TMDB suggests for this one. */
  endorsedImdbIds: Set<string>;
  /** How many TMDB offered in total, owned or not — for admin reporting only. */
  offered: number;
}

const EMPTY: TmdbSuggestions = { endorsedImdbIds: new Set(), offered: 0 };

/** The film's own IMDb id, so it can never suggest itself. */
function selfImdbId(path: string): string | null {
  const row = asRows<{ imdb_id: string | null }>(
    getDb()
      .prepare(
        `SELECT c.imdb_id FROM tmdb_links l
           JOIN tmdb_cache c ON c.kind = l.tmdb_kind AND c.tmdb_id = l.tmdb_id
            AND c.season = -1 AND c.episode = -1
          WHERE l.subject_type = 'path' AND l.subject_id = ?`,
      )
      .all(path),
  )[0];
  return row?.imdb_id ?? null;
}

export function suggestionsForPath(path: string | null | undefined): TmdbSuggestions {
  if (!path) return EMPTY;

  const db = getDb();

  const payloadRow = asRows<{ payload: string }>(
    db
      .prepare(
        `SELECT c.payload
           FROM tmdb_links l
           JOIN tmdb_cache c
             ON c.kind = l.tmdb_kind
            AND c.tmdb_id = l.tmdb_id
            AND c.season = -1
            AND c.episode = -1
          WHERE l.subject_type = 'path'
            AND l.subject_id = ?
            AND l.tmdb_kind = 'movie'
            AND l.tmdb_id > 0`,
      )
      .all(path),
  )[0];
  if (!payloadRow) return EMPTY;

  let parsed: SuggestionPayload;
  try {
    parsed = JSON.parse(payloadRow.payload) as SuggestionPayload;
  } catch {
    return EMPTY;
  }

  const suggested = [
    ...(parsed.recommendations?.results ?? []),
    ...(parsed.similar?.results ?? []),
  ].map((r) => r.id);
  if (suggested.length === 0) return EMPTY;

  const unique = [...new Set(suggested)];
  // One IN clause rather than a query per suggestion: 37 ids is well inside
  // SQLite's default 32,766 parameter ceiling, and the alternative is 37 round
  // trips to answer one question.
  const placeholders = unique.map(() => "?").join(",");
  const owned = asRows<{ imdb_id: string | null }>(
    db
      .prepare(
        `SELECT DISTINCT c.imdb_id
           FROM tmdb_links l
           JOIN tmdb_cache c
             ON c.kind = 'movie' AND c.tmdb_id = l.tmdb_id AND c.season = -1 AND c.episode = -1
          WHERE l.subject_type = 'path'
            AND l.tmdb_kind = 'movie'
            AND l.tmdb_id IN (${placeholders})
            AND c.imdb_id IS NOT NULL`,
      )
      .all(...unique),
  );

  const self = selfImdbId(path);
  const ids = owned
    .map((r) => r.imdb_id)
    .filter((id): id is string => id !== null && id !== self);

  return { endorsedImdbIds: new Set(ids), offered: unique.length };
}
