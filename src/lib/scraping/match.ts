import "server-only";

import { getAdminMovies } from "../admin-library-cache";
import { getGroupedPathMap } from "../library-curation";
import { normaliseTitle } from "../library-review";

import { looseKey, nearTitle } from "./title-match-rules";

/**
 * Resolves a raw scraped/uploaded title against the current library. Shared
 * by every ingestion path (yearendlists, Wikipedia, PDF uploads, and the
 * curator's own accolade builder) and by the library-scan relink pass, so
 * "how confident is this match" means the same thing everywhere.
 */

export type MatchConfidence = "exact" | "fuzzy" | "unmatched";

export interface MatchResult {
  imdbId: string | null;
  confidence: MatchConfidence;
}

interface LibraryEntry {
  imdbId: string;
  year: number | null;
}

// Rebuilt from Jellyfin on first use, then reused for INDEX_TTL_MS — a scrape
// run checks dozens to hundreds of titles against the same library snapshot,
// and nothing about the library changes mid-run. invalidateLibraryIndex()
// clears it after a library scan so the next scrape/relink sees new titles.
//
// The TTL is the backstop, not the main mechanism, and it is load-bearing:
// titles also arrive without anyone calling invalidateLibraryIndex() (the
// worker publishing a converted file, Jellyfin's own periodic auto-scan), and
// even the explicit call can't fully cover the manual path — /Library/Refresh
// only *starts* Jellyfin scanning and returns immediately, so the rebuild
// right after it can still read a library that hasn't finished. Without an
// expiry those cases pin one snapshot for the whole process lifetime, and a
// newly-added film stays unmatchable until the container restarts.
//
// Five minutes: long enough that a single scrape run keeps one snapshot
// throughout (the property the caching exists for), short enough that
// staleness heals on its own well before anyone notices it.
const INDEX_TTL_MS = 5 * 60 * 1000;

let cachedIndex: Map<string, LibraryEntry[]> | null = null;
let cachedAt = 0;

export function invalidateLibraryIndex(): void {
  cachedIndex = null;
}

async function getLibraryIndex(): Promise<Map<string, LibraryEntry[]>> {
  if (cachedIndex && Date.now() - cachedAt < INDEX_TTL_MS) return cachedIndex;

  const movies = await getAdminMovies({ withMediaSources: false });
  // Episodes of a show are files like any other to Jellyfin, each with a
  // title and an IMDb id of its own — and an episode called "Out of Africa"
  // or "Missing" was being handed the film's Best Picture and Palme d'Or.
  // 406 list entries were attached to episodes of E.R., Buffy and Lost that
  // way. These lists are of films; a file that is part of a show is not one.
  const inAShow = getGroupedPathMap();
  const index = new Map<string, LibraryEntry[]>();
  for (const movie of movies) {
    const imdbId = movie.ProviderIds?.Imdb;
    if (!imdbId) continue;
    if (movie.Path && inAShow.has(movie.Path)) continue;
    const key = normaliseTitle(movie.Name);
    if (!key) continue;
    if (!index.has(key)) index.set(key, []);
    index.get(key)!.push({ imdbId, year: movie.ProductionYear ?? null });
  }
  cachedIndex = index;
  cachedAt = Date.now();
  return index;
}

function withinYearTolerance(entryYear: number | null, rawYear: number | null): boolean {
  if (entryYear == null || rawYear == null) return true;
  return Math.abs(entryYear - rawYear) <= 1;
}

/**
 * "exact" — the normalised title matches a library title exactly (and the
 * year, if either side has one, is within a year).
 * "fuzzy" — the same words but for a plural or a letter in a short one
 * ("Ford vs. Ferrari" vs "Ford v Ferrari", "The Nice Guy" vs "The Nice
 * Guys"), and only when both sides give a year and the years agree. It used
 * to be word overlap, which is how "Dancer in the Dark" became "In the
 * Dark"; see title-match-rules.ts.
 * "unmatched" — nothing close enough to guess automatically; the caller
 * stores raw_title/raw_year and leaves it for the curator or a future scan.
 */
export async function matchTitle(rawTitle: string, rawYear: number | null): Promise<MatchResult> {
  const index = await getLibraryIndex();
  const key = normaliseTitle(rawTitle);
  if (!key) return { imdbId: null, confidence: "unmatched" };

  // "Ready Player One Film", as some lists write it, is that film.
  const exact = index.get(key) ?? index.get(looseKey(key));
  if (exact) {
    // Only accept a same-title candidate whose year actually checks out — a
    // title match alone isn't enough when a same-titled remake/reboot exists
    // (e.g. a 2026 "Resident Evil" must not silently resolve to the 2002
    // film's imdbId just because it's the only same-titled library entry).
    const hit = exact.find((e) => withinYearTolerance(e.year, rawYear));
    if (hit) return { imdbId: hit.imdbId, confidence: "exact" };
  }

  // A near title is a guess, and a guess needs the year to stand on: both
  // sides must give one. A list entry with no year is matched exactly or
  // left for the curator.
  if (rawYear == null) return { imdbId: null, confidence: "unmatched" };
  for (const [candidateKey, entries] of index) {
    if (!nearTitle(key, candidateKey)) continue;
    const hit = entries.find((e) => e.year != null && Math.abs(e.year - rawYear) <= 1);
    if (hit) return { imdbId: hit.imdbId, confidence: "fuzzy" };
  }
  return { imdbId: null, confidence: "unmatched" };
}
