import "server-only";

import { cached } from "./cache";
import { asRows, getDb } from "./db";
import {
  CREW_SHELF_VERB,
  daySeed,
  franchiseHeading,
  isShelfKeyword,
  keywordHeading,
  pickShelves,
  type ShelfCandidate,
} from "./home-shelves";

/**
 * Today's extra home-page shelves, built from the TMDB store.
 *
 * Building the candidate list reads every linked film's cached payload — about
 * 27 MB of JSON across 400 films — which is far too much to repeat on each home
 * page load. So the result is cached for the day. The day is also the rotation's
 * seed (see home-shelves.ts), so a cached answer can never be the wrong day's.
 */
const DAY_MS = 86_400_000;

export async function todaysShelves(): Promise<ShelfCandidate[]> {
  const seed = daySeed();
  return cached("home-shelves", String(seed), async () => pickShelves(shelfCandidates(), seed), {
    ttlMs: DAY_MS,
    staleMs: DAY_MS,
  });
}

/** The join every query below shares: a linked film and its cached payload. */
const LINKED_FILMS =
  "FROM tmdb_links l " +
  "JOIN tmdb_cache c ON c.kind = 'movie' AND c.tmdb_id = l.tmdb_id AND c.season = -1 " +
  "WHERE l.subject_type = 'path' AND l.tmdb_kind = 'movie' AND l.tmdb_id > 0";

export function shelfCandidates(): ShelfCandidate[] {
  const db = getDb();

  // Release year per film, so every shelf reads in order — a franchise from
  // its first film, a cinematographer's shelf as a career.
  const years = new Map(
    asRows<{ path: string; year: string | null }>(
      db
        .prepare(
          "SELECT l.subject_id AS path, substr(json_extract(c.payload, '$.release_date'), 1, 4) AS year " +
            LINKED_FILMS,
        )
        .all(),
    ).map((r) => [r.path, Number(r.year) || 0]),
  );
  const inOrder = (paths: Iterable<string>): string[] =>
    [...new Set(paths)].sort((a, b) => (years.get(a) ?? 0) - (years.get(b) ?? 0));

  const groups = new Map<string, { kind: ShelfCandidate["kind"]; title: string; paths: string[] }>();
  const add = (key: string, kind: ShelfCandidate["kind"], title: string, path: string): void => {
    const g = groups.get(key);
    if (g) g.paths.push(path);
    else groups.set(key, { kind, title, paths: [path] });
  };

  // Franchises: TMDB collections, which OMDb never had any notion of.
  for (const r of asRows<{ path: string; id: number | null; name: string | null }>(
    db
      .prepare(
        "SELECT l.subject_id AS path, " +
          "json_extract(c.payload, '$.belongs_to_collection.id') AS id, " +
          "json_extract(c.payload, '$.belongs_to_collection.name') AS name " +
          LINKED_FILMS +
          " AND json_extract(c.payload, '$.belongs_to_collection.id') IS NOT NULL",
      )
      .all(),
  )) {
    if (r.id == null || !r.name) continue;
    add(`franchise:${r.id}`, "franchise", franchiseHeading(r.name), r.path);
  }

  // Crew: the departments Jellyfin never held, which is the point of having
  // them — Jellyfin already gives directors and actors their own pages.
  for (const r of asRows<{ dept: string; id: number; name: string; path: string }>(
    db
      .prepare(
        "SELECT c.department AS dept, c.tmdb_person_id AS id, p.name AS name, c.subject_id AS path " +
          "FROM tmdb_credits c JOIN tmdb_people p ON p.tmdb_id = c.tmdb_person_id " +
          "WHERE c.subject_type = 'path' AND c.department IN ('cinematographers', 'composers', 'editors')",
      )
      .all(),
  )) {
    const verb = CREW_SHELF_VERB[r.dept];
    if (!verb) continue;
    add(`crew:${r.dept}:${r.id}`, "crew", `${verb} ${r.name}`, r.path);
  }

  // Keywords: subjects only — production metadata and mood tags are filtered.
  for (const r of asRows<{ path: string; kw: string | null }>(
    db
      .prepare(
        "SELECT l.subject_id AS path, lower(json_extract(k.value, '$.name')) AS kw " +
          "FROM tmdb_links l " +
          "JOIN tmdb_cache c ON c.kind = 'movie' AND c.tmdb_id = l.tmdb_id AND c.season = -1, " +
          "json_each(c.payload, '$.keywords.keywords') AS k " +
          "WHERE l.subject_type = 'path' AND l.tmdb_kind = 'movie' AND l.tmdb_id > 0",
      )
      .all(),
  )) {
    if (!r.kw || !isShelfKeyword(r.kw)) continue;
    add(`keyword:${r.kw}`, "keyword", keywordHeading(r.kw), r.path);
  }

  return [...groups.entries()].map(([key, g]) => ({
    kind: g.kind,
    key,
    title: g.title,
    paths: inOrder(g.paths),
  }));
}
