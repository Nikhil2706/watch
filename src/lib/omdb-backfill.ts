import "server-only";

import { asRow, asRows, getDb } from "./db";
import { getExternalApiUsageToday } from "./events";
import { getKnownFilms, sleep } from "./known-films";
import { getRatings, RATING_CACHE_TTL_MS } from "./ratings";

/**
 * Keeps OMDb ratings fresh across the whole library without ever bursting —
 * the plan for "what happens once we're near 1000 movies and OMDb's daily
 * cap starts to matter."
 *
 * getRatings() already caches per-film and only calls OMDb when a film's own
 * page is actually visited. That is naturally throttled by real traffic and
 * was never the risk. The risk is a LIBRARY-WIDE catch-up: a big import, or
 * a cluster of films that all first got cached the same day and so all go
 * stale on the same day seven days later. Left alone, nothing forces those
 * calls to spread out — this does.
 *
 * The approach scales to any library size by construction: each tick does a
 * small, bounded batch and stops for the day once a fixed daily budget is
 * spent (checked against the SAME external_api_calls counter every other
 * OMDb caller already feeds — a live lookup and a backfill lookup draw from
 * one shared total, so this can never push the real daily count over the
 * cap). A small library finishes its backlog in one day and coasts; a huge
 * one just takes proportionally more days — it always makes steady forward
 * progress, never all at once.
 */

/**
 * OMDb's free tier is 1000/day. This budget deliberately leaves headroom
 * below that for on-demand traffic — a real visitor loading a film page, or
 * a curator fixing up a show's episodes — so the backfill can never be the
 * reason those run out of quota.
 */
const DAILY_BUDGET = 700;
const BATCH_SIZE = 8;
export const TICK_INTERVAL_MS = 10 * 60 * 1000;
/** A short pause between calls within one batch — courteous, not required by OMDb's own terms. */
const BETWEEN_CALL_DELAY_MS = 400;

declare global {
  // eslint-disable-next-line no-var
  var __jellyfinGateOmdbBackfillStatus: OmdbBackfillStatus | undefined;
}

function budgetRemainingToday(): number {
  const usage = getExternalApiUsageToday().find((a) => a.source === "omdb");
  const usedToday = usage ? usage.successCount + usage.failureCount : 0;
  return Math.max(0, DAILY_BUDGET - usedToday);
}

export interface OmdbBackfillStatus {
  /** Every movie in the library with a known IMDb id, from the last time the list was pulled. */
  totalKnown: number;
  /** Never fetched at all. */
  missing: number;
  /** Fetched before, but past the cache TTL. */
  stale: number;
  lastTickAt: number | null;
  lastTickProcessed: number;
}

/** Cheap read for the Health tab — reports whatever the last tick already computed, never triggers new work itself. */
export function getOmdbBackfillStatus(): OmdbBackfillStatus | null {
  return globalThis.__jellyfinGateOmdbBackfillStatus ?? null;
}

/**
 * One batch of work: figure out what's most overdue, refresh a handful of
 * it, stop. Missing films (never rated at all) come first — an absent
 * rating is a worse gap than a week-old one — then the longest-stale
 * existing entries.
 */
export async function runOmdbBackfillTick(): Promise<{ processed: number; skippedBudget: boolean }> {
  const remaining = budgetRemainingToday();
  if (remaining <= 0) {
    const prior = globalThis.__jellyfinGateOmdbBackfillStatus;
    globalThis.__jellyfinGateOmdbBackfillStatus = {
      totalKnown: prior?.totalKnown ?? 0,
      missing: prior?.missing ?? 0,
      stale: prior?.stale ?? 0,
      lastTickAt: Date.now(),
      lastTickProcessed: 0,
    };
    return { processed: 0, skippedBudget: true };
  }

  const batchSize = Math.min(BATCH_SIZE, remaining);

  const knownFilms = await getKnownFilms().catch((error) => {
    console.error("[omdb-backfill] could not read movie list from Jellyfin:", error);
    return [];
  });
  const knownIds = knownFilms.map((f) => f.imdbId);

  const db = getDb();
  const cachedIds = new Set(
    asRows<{ imdb_id: string }>(db.prepare("SELECT imdb_id FROM rating_cache").all()).map((r) => r.imdb_id),
  );
  const missingIds = knownIds.filter((id) => !cachedIds.has(id));

  const staleCutoff = Date.now() - RATING_CACHE_TTL_MS;

  const staleRows = asRows<{ imdb_id: string }>(
    db
      .prepare("SELECT imdb_id FROM rating_cache WHERE fetched_at < ? ORDER BY fetched_at ASC LIMIT ?")
      .all(staleCutoff, batchSize),
  );
  const totalStale =
    asRow<{ n: number }>(db.prepare("SELECT COUNT(*) AS n FROM rating_cache WHERE fetched_at < ?").get(staleCutoff))?.n ?? 0;

  const targets = [...missingIds.slice(0, batchSize), ...staleRows.map((r) => r.imdb_id)].slice(0, batchSize);
  const unique = [...new Set(targets)];

  for (let i = 0; i < unique.length; i++) {
    await getRatings(unique[i]);
    if (i < unique.length - 1) await sleep(BETWEEN_CALL_DELAY_MS);
  }

  globalThis.__jellyfinGateOmdbBackfillStatus = {
    totalKnown: knownIds.length,
    missing: missingIds.length,
    stale: totalStale,
    lastTickAt: Date.now(),
    lastTickProcessed: unique.length,
  };

  return { processed: unique.length, skippedBudget: false };
}
