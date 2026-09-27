import "server-only";

import { generateId } from "../crypto";
import { asRow, asRows, getDb, transaction } from "../db";
import { getCollectionParts, getMovieCollection, isTmdbConfigured } from "../tmdb";
import { matchTitle } from "./match";

/*
 * Franchises ("film series"): TMDB collections (syncTmdbFranchises) and ones a
 * curator made by hand. The Wikipedia ingest that used to fill this table is
 * gone — see syncTmdbFranchises() and the v46 migration in db.ts for why.
 */

/**
 * Same "try again, now that the library has more in it" pass as
 * relinkUnmatchedArticleLinks(), for series entries — and, like that
 * function, also re-checks existing "exact" rows so a matchTitle() logic
 * change corrects already-stored matches, not just future ones. Rows that
 * come back unchanged are skipped, only real corrections get written.
 */
export async function relinkUnmatchedFilmSeriesEntries(): Promise<number> {
  const candidates = asRows<{
    id: string;
    raw_title: string;
    raw_year: number | null;
    imdb_id: string | null;
    confidence: string;
  }>(
    getDb()
      .prepare(
        // Hand-made franchises only. A TMDB franchise's entries come from TMDB
        // ids (syncTmdbFranchises re-resolves them every run); title-matching
        // them here is how the Wikipedia data went wrong.
        `SELECT e.id, e.raw_title, e.raw_year, e.imdb_id, e.confidence
           FROM film_series_entries e JOIN film_series s ON s.id = e.series_id
          WHERE s.wiki_page = ? AND (e.imdb_id IS NULL OR e.confidence = 'exact')`,
      )
      .all(MANUAL_WIKI_PAGE),
  );
  let relinked = 0;
  for (const row of candidates) {
    const match = await matchTitle(row.raw_title, row.raw_year);
    if (match.imdbId === row.imdb_id && match.confidence === row.confidence) continue;
    getDb()
      .prepare("UPDATE film_series_entries SET imdb_id = ?, confidence = ? WHERE id = ?")
      .run(match.imdbId, match.confidence, row.id);
    relinked++;
  }
  return relinked;
}

export interface SeriesEntry {
  position: number;
  raw_title: string;
  raw_year: number | null;
  imdb_id: string | null;
}

export interface SeriesContext {
  seriesId: string;
  seriesName: string;
  entries: SeriesEntry[];
}

/** Every entry of the series a given library film belongs to, in release order — null if it isn't part of any scraped series. */
export function getSeriesContextForFilm(imdbId: string): SeriesContext | null {
  const membership = asRow<{ series_id: string; series_name: string }>(
    getDb()
      .prepare(
        `SELECT fs.id AS series_id, fs.name AS series_name
           FROM film_series_entries fse
           JOIN film_series fs ON fs.id = fse.series_id
          WHERE fse.imdb_id = ?
          LIMIT 1`,
      )
      .get(imdbId),
  );
  if (!membership) return null;

  const entries = asRows<SeriesEntry>(
    getDb()
      .prepare(
        "SELECT position, raw_title, raw_year, imdb_id FROM film_series_entries WHERE series_id = ? ORDER BY position",
      )
      .all(membership.series_id),
  );

  return { seriesId: membership.series_id, seriesName: membership.series_name, entries };
}

export interface SeriesListEntry {
  id: string;
  name: string;
  entryCount: number;
  /** Entries resolved to an IMDb id. For a TMDB franchise that means owned: its entries are only given one when the film is in the library. */
  matchedCount: number;
  source: "tmdb" | "manual";
}

/** Every franchise, for the console's Franchises tab. */
/**
 * Create a franchise by hand.
 *
 * The ingest above sources franchises from Wikipedia's own WikiProject-
 * maintained bucket index, which is excellent for the franchises it covers and
 * silent about the ones it does not. [REC] is the case that surfaced this: four
 * films, in the library, and absent from every bucket page — so there was no
 * route by which it could ever appear, and no way to say so by hand.
 *
 * Manual series are marked by a wiki_page of MANUAL_WIKI_PAGE so a later ingest
 * cannot quietly overwrite or delete them: the ingest keys on the Wikipedia
 * bucket title, and nothing it scrapes will ever carry this one.
 */
export const MANUAL_WIKI_PAGE = "(added by hand)";

/** Marks a franchise discovered from TMDB's belongs_to_collection rather than Wikipedia. */
export const TMDB_WIKI_PAGE = "(TMDB collection)";

export function createManualSeries(name: string): { id: string; name: string } {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("a franchise needs a name");

  const existing = asRow<{ id: string }>(
    getDb().prepare("SELECT id FROM film_series WHERE name = ?").get(trimmed),
  );
  if (existing) return { id: existing.id, name: trimmed };

  const id = generateId();
  const now = Date.now();
  getDb()
    .prepare("INSERT INTO film_series (id, name, wiki_page, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run(id, trimmed, MANUAL_WIKI_PAGE, now, now);
  return { id, name: trimmed };
}

/**
 * Add one film to a franchise, at the end.
 *
 * imdbId resolution is the caller's, exactly as the ingest does it — an entry
 * with no match is a real state here too ("not yet in the library"), and the
 * next library scan re-resolves it the same way.
 */
export function addSeriesEntry(input: {
  seriesId: string;
  title: string;
  year: number | null;
  imdbId: string | null;
}): { id: string; position: number } {
  const last = asRow<{ n: number | null }>(
    getDb().prepare("SELECT MAX(position) AS n FROM film_series_entries WHERE series_id = ?").get(input.seriesId),
  );
  const position = (last?.n ?? -1) + 1;
  const id = generateId();
  getDb()
    .prepare(
      `INSERT INTO film_series_entries (id, series_id, position, raw_title, raw_year, imdb_id, confidence, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, input.seriesId, position, input.title.trim(), input.year, input.imdbId, 1, Date.now());
  getDb().prepare("UPDATE film_series SET updated_at = ? WHERE id = ?").run(Date.now(), input.seriesId);
  return { id, position };
}

/** Remove one entry, closing the gap so positions stay dense. */
export function removeSeriesEntry(seriesId: string, entryId: string): boolean {
  const result = getDb()
    .prepare("DELETE FROM film_series_entries WHERE id = ? AND series_id = ?")
    .run(entryId, seriesId);
  if (Number(result.changes) === 0) return false;

  transaction((db) => {
    const rows = asRows<{ id: string }>(
      db.prepare("SELECT id FROM film_series_entries WHERE series_id = ? ORDER BY position ASC").all(seriesId),
    );
    rows.forEach((r, i) => {
      db.prepare("UPDATE film_series_entries SET position = ? WHERE id = ?").run(i, r.id);
    });
    db.prepare("UPDATE film_series SET updated_at = ? WHERE id = ?").run(Date.now(), seriesId);
  });
  return true;
}

/** Delete a whole franchise. Entries cascade. */
export function deleteSeries(seriesId: string): boolean {
  const result = getDb().prepare("DELETE FROM film_series WHERE id = ?").run(seriesId);
  return Number(result.changes) > 0;
}

export function listAllSeries(): SeriesListEntry[] {
  // Incomplete first — they're the ones with something to do — then by name.
  return asRows<SeriesListEntry & { wiki_page: string | null }>(
    getDb()
      .prepare(
        `SELECT fs.id AS id, fs.name AS name, fs.wiki_page AS wiki_page,
                COUNT(fse.id) AS entryCount,
                COUNT(fse.imdb_id) AS matchedCount
           FROM film_series fs
           LEFT JOIN film_series_entries fse ON fse.series_id = fs.id
          GROUP BY fs.id
          ORDER BY (COUNT(fse.imdb_id) >= COUNT(fse.id)) ASC, fs.name ASC`,
      )
      .all(),
  ).map(({ wiki_page, ...row }) => ({ ...row, source: wiki_page === TMDB_WIKI_PAGE ? "tmdb" : "manual" }));
}

/**
 * Every franchise this film is in, for the film's own panel in the workspace.
 *
 * getSeriesContextForFilm() above answers "what is this film's series" with a
 * LIMIT 1, which is right for the viewer-facing page. The curator's panel needs
 * the full truth: a film can sit in more than one, and the entry id is what a
 * remove button needs to act on.
 */
export interface FilmSeriesMembership {
  seriesId: string;
  seriesName: string;
  entryId: string;
  position: number;
  manual: boolean;
}

export function seriesForFilm(imdbId: string): FilmSeriesMembership[] {
  return asRows<{
    seriesId: string;
    seriesName: string;
    entryId: string;
    position: number;
    wiki_page: string;
  }>(
    getDb()
      .prepare(
        `SELECT fs.id AS seriesId, fs.name AS seriesName, fse.id AS entryId,
                fse.position AS position, fs.wiki_page AS wiki_page
           FROM film_series_entries fse
           JOIN film_series fs ON fs.id = fse.series_id
          WHERE fse.imdb_id = ?
          ORDER BY fs.name ASC`,
      )
      .all(imdbId),
  ).map((r) => ({
    seriesId: r.seriesId,
    seriesName: r.seriesName,
    entryId: r.entryId,
    position: r.position,
    manual: r.wiki_page === MANUAL_WIKI_PAGE || r.wiki_page === TMDB_WIKI_PAGE,
  }));
}

export interface TmdbFranchiseResult {
  created: boolean;
  seriesId: string | null;
  name: string | null;
  entries: number;
  matched: number;
  reason?: string;
}

/**
 * Build a franchise from TMDB's own collection for one film.
 *
 * The Wikipedia ingest sources franchises from a WikiProject-maintained bucket
 * index, which is thorough for what it covers and simply silent about the rest.
 * [REC] is the case that exposed it: four films, all in the library, listed on
 * none of the eleven bucket pages, so no amount of re-running the scrape would
 * ever have produced it.
 *
 * TMDB carries the same fact on the ordinary movie record as
 * belongs_to_collection. OMDb has no equivalent field at all, which is why this
 * could never have come from the same place the ratings do.
 *
 * Replaces the entries of a series it already owns rather than appending, so
 * running it twice is idempotent. It will not touch a Wikipedia-sourced series.
 */
export async function buildFranchiseFromTmdb(
  tmdbId: number,
): Promise<TmdbFranchiseResult> {
  if (!isTmdbConfigured()) {
    return { created: false, seriesId: null, name: null, entries: 0, matched: 0, reason: "TMDB is not configured." };
  }

  const collection = await getMovieCollection(tmdbId);
  if (!collection) {
    return { created: false, seriesId: null, name: null, entries: 0, matched: 0, reason: "TMDB has no collection for this film." };
  }

  const parts = await getCollectionParts(collection.id);
  if (parts.length === 0) {
    return { created: false, seriesId: null, name: collection.name, entries: 0, matched: 0, reason: "That collection is empty." };
  }

  const now = Date.now();
  const existing = asRow<{ id: string; wiki_page: string }>(
    getDb().prepare("SELECT id, wiki_page FROM film_series WHERE name = ?").get(collection.name),
  );

  // Never overwrite a Wikipedia-sourced series: the ingest owns those, and it
  // would silently undo this on its next run anyway.
  if (existing && existing.wiki_page !== TMDB_WIKI_PAGE) {
    return {
      created: false,
      seriesId: existing.id,
      name: collection.name,
      entries: 0,
      matched: 0,
      reason: "A franchise with that name already came from Wikipedia.",
    };
  }

  const seriesId = existing?.id ?? generateId();
  let matched = 0;

  transaction((db) => {
    if (existing) {
      db.prepare("UPDATE film_series SET updated_at = ? WHERE id = ?").run(now, seriesId);
      db.prepare("DELETE FROM film_series_entries WHERE series_id = ?").run(seriesId);
    } else {
      db.prepare(
        "INSERT INTO film_series (id, name, wiki_page, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ).run(seriesId, collection.name, TMDB_WIKI_PAGE, now, now);
    }

    parts.forEach((part, position) => {
      if (part.imdbId) matched += 1;
      db.prepare(
        `INSERT INTO film_series_entries (id, series_id, position, raw_title, raw_year, imdb_id, confidence, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(generateId(), seriesId, position, part.title, part.year, part.imdbId, 1, now);
    });
  });

  return { created: !existing, seriesId, name: collection.name, entries: parts.length, matched };
}

/** One series by id, same shape as getSeriesContextForFilm — null if the id doesn't exist. */
export function getSeriesById(seriesId: string): SeriesContext | null {
  const row = asRow<{ id: string; name: string }>(getDb().prepare("SELECT id, name FROM film_series WHERE id = ?").get(seriesId));
  if (!row) return null;

  const entries = asRows<SeriesEntry>(
    getDb()
      .prepare("SELECT position, raw_title, raw_year, imdb_id FROM film_series_entries WHERE series_id = ? ORDER BY position")
      .all(seriesId),
  );

  return { seriesId: row.id, seriesName: row.name, entries };
}

export interface TmdbFranchiseSyncResult {
  /** Collections at least one film in the library belongs to. */
  collections: number;
  created: number;
  updated: number;
  /** Collection records fetched from TMDB this run (the rest were cached). */
  fetched: number;
  failures: number;
  /** TMDB franchises dropped because no film in the library is in them any more. */
  removed: number;
  /** False when the budget ran out before every collection was fetched. */
  done: boolean;
}

/**
 * Franchises, from TMDB alone: every collection a film in the library belongs
 * to, with all of its films, so the console can show which are complete.
 *
 * Replaces the Wikipedia ingest, whose bucket-page parser lost track of where
 * one franchise ended and ran several into the next — Hell House LLC ended up
 * as films 16–18 of "Has Fallen". TMDB states membership per film
 * (belongs_to_collection, already in the cached movie record) and per
 * collection (its parts), so there is nothing to parse and nothing to guess.
 *
 * Cheap to repeat: membership comes from the movie cache, and each collection
 * costs one request the first time and none after (tmdb_cache). Which films are
 * owned is resolved by TMDB id through tmdb_links, never by title. Hand-made
 * franchises are left alone, and so is any name one of them already uses.
 */
export async function syncTmdbFranchises(budget = 40): Promise<TmdbFranchiseSyncResult> {
  const { fetchCollection, getCached } = await import("../tmdb-store");
  const db = getDb();
  const result: TmdbFranchiseSyncResult = {
    collections: 0,
    created: 0,
    updated: 0,
    fetched: 0,
    failures: 0,
    removed: 0,
    done: true,
  };

  const owned = asRows<{ tmdbId: number; imdbId: string | null; cid: number | null; cname: string | null }>(
    db
      .prepare(
        `SELECT DISTINCT l.tmdb_id AS tmdbId, c.imdb_id AS imdbId,
                json_extract(c.payload, '$.belongs_to_collection.id') AS cid,
                json_extract(c.payload, '$.belongs_to_collection.name') AS cname
           FROM tmdb_links l
           JOIN tmdb_cache c ON c.kind = 'movie' AND c.tmdb_id = l.tmdb_id AND c.season = -1
          WHERE l.subject_type = 'path' AND l.tmdb_kind = 'movie' AND l.tmdb_id > 0`,
      )
      .all(),
  );
  const imdbByTmdb = new Map<number, string | null>();
  const collections = new Map<number, string>();
  for (const o of owned) {
    imdbByTmdb.set(o.tmdbId, o.imdbId);
    if (o.cid != null && o.cname) collections.set(o.cid, o.cname);
  }
  result.collections = collections.size;

  const keep = new Set<string>();
  for (const [cid, fallbackName] of collections) {
    let payload = getCached<CollectionPayload>("collection", cid)?.payload ?? null;
    if (!payload) {
      if (result.fetched >= budget) {
        result.done = false;
        continue;
      }
      try {
        payload = (await fetchCollection(cid)).payload as CollectionPayload;
        result.fetched += 1;
      } catch {
        result.failures += 1;
        continue;
      }
    }
    const name = (payload.name || fallbackName).trim();
    keep.add(name);
    const parts = (payload.parts ?? [])
      .slice()
      .sort((a, b) => (a.release_date || "9999").localeCompare(b.release_date || "9999"));
    if (parts.length === 0) continue;

    const existing = asRow<{ id: string; wiki_page: string | null }>(
      db.prepare("SELECT id, wiki_page FROM film_series WHERE name = ?").get(name),
    );
    // A franchise made by hand under the same name is the curator's; leave it.
    if (existing && existing.wiki_page !== TMDB_WIKI_PAGE) continue;

    const now = Date.now();
    const seriesId = existing?.id ?? generateId();
    transaction((tx) => {
      if (existing) {
        tx.prepare("UPDATE film_series SET updated_at = ? WHERE id = ?").run(now, seriesId);
        tx.prepare("DELETE FROM film_series_entries WHERE series_id = ?").run(seriesId);
      } else {
        tx.prepare("INSERT INTO film_series (id, name, wiki_page, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(
          seriesId,
          name,
          TMDB_WIKI_PAGE,
          now,
          now,
        );
      }
      parts.forEach((part, position) => {
        const year = part.release_date ? Number(part.release_date.slice(0, 4)) : null;
        const imdbId = imdbByTmdb.get(part.id) ?? null;
        tx.prepare(
          `INSERT INTO film_series_entries (id, series_id, position, raw_title, raw_year, imdb_id, confidence, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          generateId(),
          seriesId,
          position,
          part.title ?? "",
          Number.isFinite(year) ? year : null,
          imdbId,
          // "tmdb": resolved by TMDB id, not by title — owned or not.
          "tmdb",
          now,
        );
      });
    });
    if (existing) result.updated += 1;
    else result.created += 1;
  }

  // A TMDB franchise none of whose films is here any more (the last one was
  // deleted, or relinked elsewhere). Only on a complete run: a budget-limited
  // one hasn't seen every collection, so it can't know what's gone.
  if (result.done) {
    const stale = asRows<{ id: string; name: string }>(
      db.prepare("SELECT id, name FROM film_series WHERE wiki_page = ?").all(TMDB_WIKI_PAGE),
    ).filter((s) => !keep.has(s.name));
    for (const s of stale) {
      transaction((tx) => {
        tx.prepare("DELETE FROM film_series_entries WHERE series_id = ?").run(s.id);
        tx.prepare("DELETE FROM library_rollout_plans WHERE subject_type = 'series' AND subject_id = ?").run(s.id);
        tx.prepare("DELETE FROM film_series WHERE id = ?").run(s.id);
      });
      result.removed += 1;
    }
  }
  return result;
}

interface CollectionPayload {
  name?: string;
  parts?: Array<{ id: number; title?: string; release_date?: string }>;
}
