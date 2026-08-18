import "server-only";

import { generateId } from "../crypto";
import { asRow, asRows, getDb, transaction } from "../db";
import { logEvent, recordExternalApiCall } from "../events";
import { matchTitle } from "./match";

/**
 * Film-series membership, sourced from Wikipedia's own maintained meta-index
 * at "Lists of feature film series" -> eleven "List of feature film series
 * with N entries" pages (bucketed by count: three entries, four, five, ...,
 * "11 to 20", "21 to 30", "more than thirty"). Deliberately not the
 * per-film infobox `preceded_by`/`followed_by` fields that older franchise
 * pages used to carry — checked three well-known sequels (The Dark Knight,
 * Iron Man 2, Halloween II (1981)) live and none had those fields populated;
 * that convention isn't reliably present anymore.
 *
 * The eleven bucket pages share one consistent, WikiProject-maintained
 * format (not a wikitable): a franchise header line, then its films as a
 * nested bullet list, e.g.
 *   *''[[Some Franchise]]''
 *   *#''[[First Film]]'' (1999)
 *   *#''[[Second Film]]'' (2001)
 * That consistency is what makes one parser workable across every franchise
 * in the index, rather than needing a bespoke parser per franchise's own
 * separate "List of X films" page (which do vary in structure).
 */

const API_BASE = "https://en.wikipedia.org/w/rest.php/v1";
const USER_AGENT = "jellyfin-gate-curation/1.0 (self-hosted personal media library; single-user, non-commercial)";
const INDEX_PAGE = "Lists of feature film series";

interface PageSource {
  title: string;
  source: string;
}

async function wikiFetch<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      recordExternalApiCall("wikipedia", res.status === 404);
      return null;
    }
    recordExternalApiCall("wikipedia", true);
    return (await res.json()) as T;
  } catch (error) {
    recordExternalApiCall("wikipedia", false);
    logEvent({
      category: "external_api",
      severity: "warning",
      source: "wikipedia",
      message: `Film-series index request failed: ${path}`,
      detail: { path, error: error instanceof Error ? error.message : String(error) },
    });
    return null;
  }
}

async function fetchPage(title: string): Promise<PageSource | null> {
  return wikiFetch<PageSource>(`/page/${encodeURIComponent(title.replace(/ /g, "_"))}`);
}

/** The "By number of entries" section's page titles from the master index — deliberately not the "By country"/"By studio" links below it, which point at sections of unrelated articles rather than clean list pages in the same format. */
export function extractBucketPageTitles(indexWikitext: string): string[] {
  const sectionMatch = indexWikitext.match(/==By number of entries==([\s\S]*?)(?:\n==|$)/);
  if (!sectionMatch?.[1]) return [];

  const titles: string[] = [];
  for (const m of sectionMatch[1].matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)) {
    if (m[1]) titles.push(m[1].trim());
  }
  return titles;
}

export interface ParsedSeries {
  name: string;
  entries: Array<{ title: string; year: number | null }>;
}

// Two header conventions both appear across the eleven bucket pages: most
// franchises wrap the whole link in italics (`*''[[Star Trek]]''`), but some
// (e.g. "Sherlock Holmes (1939 film series)" on the 11-to-20 page) instead
// wrap only the piped display text (`*[[Sherlock Holmes (1939 film series)|
// ''Sherlock Holmes'' (1939 film series)]]`). Missing the second form isn't
// just a skipped franchise — parseSeriesBucketPage() below keeps `current`
// pointing at whatever franchise opened last, so every one of that
// franchise's `*#` entries silently gets attributed to the PREVIOUS
// franchise instead. Caught live: Sherlock Holmes's 14 films all landed
// under "Star Trek" in the first real ingest run.
const HEADER_LINE = /^\*(?!#)\s*(?:'{0,2}''\[\[([^\]|]+)(?:\|[^\]]*)?\]\]''|\[\[([^\]|]+)\|[^\]]*\]\])/;
// Deliberately stops at the closing ''  rather than also trying to capture
// a trailing "(Year)" in the same match: a lazy `.*?` followed by an
// OPTIONAL year group never gets forced to consume the year — since the
// group can trivially match zero-width, the engine reports success right
// after the closing '' and the year group comes back undefined every time.
// Caught live: raw_year was silently null on every single entry across all
// 699 series in the first real ingest run, which in turn starved
// matchTitle()'s year-tolerance check of any signal (see match.ts) and let
// "The Dark Knight" fuzzy-match onto The Dark Knight Rises' IMDb id. The
// year is pulled separately, from the rest of the line after this match.
const ENTRY_LINE = /^\*#\s*'{0,2}''\[\[([^\]|]+)(?:\|([^\]]*))?\]\]''/;

/**
 * One bucket page -> every franchise it lists, in order, with their films in
 * release order. A line starting `*` (not `*#`) with either header
 * convention above opens a new franchise; every following `*#''[[...]]''`
 * line (optionally `(Year)`) is one of its films, until the next header line
 * or the block ends. Franchises with no `*#` entries under them (a
 * redirect-only stub, or a header format neither convention above matches)
 * are skipped rather than stored empty.
 */
export function parseSeriesBucketPage(wikitext: string): ParsedSeries[] {
  const lines = wikitext.split("\n");
  const series: ParsedSeries[] = [];
  let current: ParsedSeries | null = null;

  for (const line of lines) {
    const entryMatch = line.match(ENTRY_LINE);
    if (entryMatch && current) {
      const title = (entryMatch[2] ?? entryMatch[1])!.trim();
      const yearMatch = line.slice(entryMatch[0].length).match(/\((\d{4})\)/);
      const year = yearMatch ? Number.parseInt(yearMatch[1]!, 10) : null;
      if (title) current.entries.push({ title, year });
      continue;
    }

    const headerMatch = line.match(HEADER_LINE);
    const headerName = headerMatch?.[1] ?? headerMatch?.[2];
    if (headerName) {
      if (current && current.entries.length > 0) series.push(current);
      current = { name: headerName.trim(), entries: [] };
    }
  }
  if (current && current.entries.length > 0) series.push(current);

  return series;
}

export interface FilmSeriesIngestResult {
  seriesProcessed: number;
  entriesProcessed: number;
  matchedCount: number;
}

/**
 * Full ingest: master index -> every bucket page -> every franchise's films,
 * matched against the library and stored. Re-running replaces a series'
 * entries wholesale (same "delete then re-insert" shape upsertScrapedArticle
 * uses for articles) rather than trying to diff — Wikipedia's own list is
 * the source of truth, not incremental edits layered on top of it.
 */
export async function runFilmSeriesIngest(): Promise<FilmSeriesIngestResult> {
  const index = await fetchPage(INDEX_PAGE);
  if (!index) return { seriesProcessed: 0, entriesProcessed: 0, matchedCount: 0 };

  const bucketTitles = extractBucketPageTitles(index.source);

  let seriesProcessed = 0;
  let entriesProcessed = 0;
  let matchedCount = 0;

  for (const bucketTitle of bucketTitles) {
    const page = await fetchPage(bucketTitle);
    if (!page) continue;

    const parsed = parseSeriesBucketPage(page.source);

    for (const s of parsed) {
      const resolved = await Promise.all(
        s.entries.map(async (e) => ({ ...e, match: await matchTitle(e.title, e.year) })),
      );

      const now = Date.now();
      const existing = asRow<{ id: string }>(
        getDb().prepare("SELECT id FROM film_series WHERE name = ?").get(s.name),
      );
      const seriesId = existing?.id ?? generateId();

      transaction((db) => {
        if (existing) {
          db.prepare("UPDATE film_series SET wiki_page = ?, updated_at = ? WHERE id = ?").run(
            bucketTitle,
            now,
            seriesId,
          );
          db.prepare("DELETE FROM film_series_entries WHERE series_id = ?").run(seriesId);
        } else {
          db.prepare(
            "INSERT INTO film_series (id, name, wiki_page, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
          ).run(seriesId, s.name, bucketTitle, now, now);
        }

        resolved.forEach((e, position) => {
          db.prepare(
            `INSERT INTO film_series_entries (id, series_id, position, raw_title, raw_year, imdb_id, confidence, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(generateId(), seriesId, position, e.title, e.year, e.match.imdbId, e.match.confidence, now);
        });
      });

      seriesProcessed++;
      entriesProcessed += resolved.length;
      matchedCount += resolved.filter((e) => e.match.confidence !== "unmatched").length;
    }
  }

  return { seriesProcessed, entriesProcessed, matchedCount };
}

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
        "SELECT id, raw_title, raw_year, imdb_id, confidence FROM film_series_entries WHERE imdb_id IS NULL OR confidence = 'exact'",
      )
      .all(),
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
