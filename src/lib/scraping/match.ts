import "server-only";

import { listAllMoviesAdmin } from "../jellyfin";
import { normaliseTitle } from "../library-review";

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

  const movies = await listAllMoviesAdmin();
  const index = new Map<string, LibraryEntry[]>();
  for (const movie of movies) {
    const imdbId = movie.ProviderIds?.Imdb;
    if (!imdbId) continue;
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
 * "fuzzy" — enough word overlap to catch punctuation drift ("Ford vs.
 * Ferrari" vs "Ford v Ferrari") or a missing plural ("The Nice Guy" vs "The
 * Nice Guys"), still within year tolerance.
 * "unmatched" — nothing close enough to guess automatically; the caller
 * stores raw_title/raw_year and leaves it for the curator or a future scan.
 */
export async function matchTitle(rawTitle: string, rawYear: number | null): Promise<MatchResult> {
  const index = await getLibraryIndex();
  const key = normaliseTitle(rawTitle);
  if (!key) return { imdbId: null, confidence: "unmatched" };

  const exact = index.get(key);
  if (exact) {
    // Only accept a same-title candidate whose year actually checks out — a
    // title match alone isn't enough when a same-titled remake/reboot exists
    // (e.g. a 2026 "Resident Evil" must not silently resolve to the 2002
    // film's imdbId just because it's the only same-titled library entry).
    const hit = exact.find((e) => withinYearTolerance(e.year, rawYear));
    if (hit) return { imdbId: hit.imdbId, confidence: "exact" };
  }

  const keyTokens = new Set(key.split(" ").filter(Boolean));
  if (keyTokens.size === 0) return { imdbId: null, confidence: "unmatched" };

  let best: { entry: LibraryEntry; score: number } | null = null;
  for (const [candidateKey, entries] of index) {
    const candidateTokens = candidateKey.split(" ").filter(Boolean);
    if (candidateTokens.length === 0) continue;
    const overlap = candidateTokens.filter((t) => keyTokens.has(t)).length;
    const score = overlap / Math.max(candidateTokens.length, keyTokens.size);
    // 0.7 tolerates one dropped/changed token in a multi-word title (a
    // punctuation split, a missing plural) without matching on title alone.
    if (score < 0.7) continue;
    for (const entry of entries) {
      if (!withinYearTolerance(entry.year, rawYear)) continue;
      if (!best || score > best.score) best = { entry, score };
    }
  }

  if (best) return { imdbId: best.entry.imdbId, confidence: "fuzzy" };
  return { imdbId: null, confidence: "unmatched" };
}
