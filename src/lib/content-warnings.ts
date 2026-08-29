import "server-only";

import { asRow, asRows, getDb } from "./db";
import { findDddItemByImdbId, getDddSignal, isDddConfigured } from "./ddd";
import { getKnownFilms, sleep } from "./known-films";
import { findTmdbMovieByImdbId, getContentSignal, isTmdbConfigured } from "./tmdb";

/**
 * Keeps content_warnings populated across the whole library — same shape as
 * omdb-backfill.ts, a small bounded batch per tick rather than one live
 * TMDB/DDD call per page view. See parental-control.ts for how the cached
 * result is actually used, and schema.ts's content_warnings table comment
 * for why this needs to be a cache at all.
 *
 * No daily budget like OMDb's — but the pacing below is NOT just politeness
 * for both sources equally. TMDB's free-tier limit is generous (tens of
 * requests/second); DDD's is 30 requests/MINUTE, and checkOne() spends up
 * to 2 of those per film (search + item detail). The delay is sized for
 * DDD's ceiling, not TMDB's — at ~13 films/minute this stays under it with
 * margin; a larger delay would just make TMDB's half of the work slower
 * than it needs to be for no benefit.
 */

const BATCH_SIZE = 10;
export const TICK_INTERVAL_MS = 10 * 60 * 1000;
const BETWEEN_CALL_DELAY_MS = 4_500;
/** Certifications/keywords for a title essentially never change after release — long TTL, mostly here so a title's data eventually gets re-checked rather than never. */
const CONTENT_WARNING_CACHE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

interface ContentWarningRow {
  imdb_id: string;
  restricted: number;
  signals: string;
  checked_at: number;
}

export interface CachedContentWarning {
  restricted: boolean;
  signals: string[];
}

export interface ContentWarningDisplay {
  /** e.g. "US: R", "GB: 18" — from TMDB certifications. */
  certifications: string[];
  /** Readable topic/keyword labels, deduplicated, DDD's vote-count parenthetical stripped. */
  topics: string[];
  /** Whether any of the above came from DDD — gates whether the attribution link needs to show. */
  hasDddSource: boolean;
}

/**
 * Turns the raw signals array (built for a curator sanity-checking a
 * surprising result — "US:R", "keyword:nudity", "ddd:there's excessive gore
 * (4 yes / 0 no)") into something a viewer can actually read. Returns null
 * for "nothing to show" (no signals at all), same as getCachedContentWarning
 * returning null for "never checked" — a caller needs to keep those two
 * states distinct rather than treating an empty result as "confirmed clean".
 */
export function toDisplaySignals(warning: CachedContentWarning): ContentWarningDisplay | null {
  if (warning.signals.length === 0) return null;

  const certifications: string[] = [];
  const topics = new Set<string>();
  let hasDddSource = false;

  for (const signal of warning.signals) {
    if (signal.startsWith("ddd:")) {
      hasDddSource = true;
      // "ddd:there's excessive gore (4 yes / 0 no)" -> "there's excessive gore"
      topics.add(signal.slice(4).replace(/\s*\(\d+ yes \/ \d+ no\)\s*$/, "").trim());
    } else if (signal.startsWith("keyword:")) {
      topics.add(signal.slice(8).trim());
    } else if (/^[A-Z]{2}:/.test(signal)) {
      certifications.push(signal.replace(":", ": "));
    }
  }

  return { certifications: [...new Set(certifications)], topics: [...topics], hasDddSource };
}

/** Sync local read — the hot-path call, used by parental-control.ts on every filterVisible()/getItem() check. */
export function getCachedContentWarning(imdbId: string): CachedContentWarning | null {
  const row = asRow<ContentWarningRow>(
    getDb().prepare("SELECT * FROM content_warnings WHERE imdb_id = ?").get(imdbId),
  );
  if (!row) return null;
  let signals: string[];
  try {
    signals = JSON.parse(row.signals);
  } catch {
    signals = [];
  }
  return { restricted: row.restricted === 1, signals };
}

function writeCache(imdbId: string, result: CachedContentWarning): void {
  getDb()
    .prepare(
      `INSERT INTO content_warnings (imdb_id, restricted, signals, checked_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(imdb_id) DO UPDATE SET
         restricted = excluded.restricted,
         signals    = excluded.signals,
         checked_at = excluded.checked_at`,
    )
    .run(imdbId, result.restricted ? 1 : 0, JSON.stringify(result.signals), Date.now());
}

/**
 * Fetches and caches one title from every configured source, OR'd together
 * — either one flagging it is enough to restrict. Each source's own
 * failure is caught independently so DDD being down (say) doesn't also
 * lose a genuine TMDB result for the same title, or vice versa.
 */
async function checkOne(imdbId: string): Promise<void> {
  const signals: string[] = [];

  if (isTmdbConfigured()) {
    try {
      const tmdbId = await findTmdbMovieByImdbId(imdbId);
      if (tmdbId) signals.push(...(await getContentSignal(tmdbId)).signals);
    } catch (error) {
      console.error(`[content-warnings] TMDB check failed for ${imdbId}:`, error);
    }
  }

  if (isDddConfigured()) {
    try {
      const dddId = await findDddItemByImdbId(imdbId);
      if (dddId) signals.push(...(await getDddSignal(dddId)).signals);
    } catch (error) {
      console.error(`[content-warnings] DDD check failed for ${imdbId}:`, error);
    }
  }

  writeCache(imdbId, { restricted: signals.length > 0, signals });
}

export interface ContentWarningBackfillStatus {
  totalKnown: number;
  missing: number;
  stale: number;
  lastTickAt: number | null;
  lastTickProcessed: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __jellyfinGateContentWarningBackfillStatus: ContentWarningBackfillStatus | undefined;
}

export function getContentWarningBackfillStatus(): ContentWarningBackfillStatus | null {
  return globalThis.__jellyfinGateContentWarningBackfillStatus ?? null;
}

export async function runContentWarningBackfillTick(): Promise<{ processed: number }> {
  if (!isTmdbConfigured() && !isDddConfigured()) return { processed: 0 };

  const knownFilms = await getKnownFilms().catch((error) => {
    console.error("[content-warnings] could not read movie list from Jellyfin:", error);
    return [];
  });
  const knownIds = knownFilms.map((f) => f.imdbId);

  const db = getDb();
  const cachedIds = new Set(
    asRows<{ imdb_id: string }>(db.prepare("SELECT imdb_id FROM content_warnings").all()).map((r) => r.imdb_id),
  );
  const missingIds = knownIds.filter((id) => !cachedIds.has(id));

  const staleCutoff = Date.now() - CONTENT_WARNING_CACHE_TTL_MS;
  const staleRows = asRows<{ imdb_id: string }>(
    db
      .prepare("SELECT imdb_id FROM content_warnings WHERE checked_at < ? ORDER BY checked_at ASC LIMIT ?")
      .all(staleCutoff, BATCH_SIZE),
  );
  const totalStale =
    asRow<{ n: number }>(db.prepare("SELECT COUNT(*) AS n FROM content_warnings WHERE checked_at < ?").get(staleCutoff))
      ?.n ?? 0;

  const targets = [...missingIds.slice(0, BATCH_SIZE), ...staleRows.map((r) => r.imdb_id)].slice(0, BATCH_SIZE);
  const unique = [...new Set(targets)];

  for (let i = 0; i < unique.length; i++) {
    await checkOne(unique[i]!);
    if (i < unique.length - 1) await sleep(BETWEEN_CALL_DELAY_MS);
  }

  globalThis.__jellyfinGateContentWarningBackfillStatus = {
    totalKnown: knownIds.length,
    missing: missingIds.length,
    stale: totalStale,
    lastTickAt: Date.now(),
    lastTickProcessed: unique.length,
  };

  return { processed: unique.length };
}
