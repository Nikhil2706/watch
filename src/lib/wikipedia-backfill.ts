import "server-only";

import { asRows, getDb } from "./db";
import { getKnownFilms, sleep } from "./known-films";
import { createScrapeJob, markScrapeJobDone, markScrapeJobFailed } from "./scraping/jobs";
import { fetchWikipediaForFilm } from "./scraping/wikipedia";

/**
 * Works through the library's Wikipedia coverage a few films at a time,
 * same "small batches, never all at once" reasoning as omdb-backfill.ts —
 * except there's no daily cap to respect (Wikipedia's API has none), so
 * this is purely about pacing/politeness, not quota management.
 *
 * "Already tried" is tracked via scrape_jobs.film_imdb_id (see that
 * column's own comment in schema.ts): any wikipedia job — done OR failed —
 * recorded against a film counts as tried, so a film with no Wikipedia
 * page doesn't get re-attempted every single tick forever. The per-film
 * dashboard "Fetch Wikipedia data" button and this backfill both write
 * through the same createScrapeJob() call, so they share one history.
 */

const BATCH_SIZE = 5;
export const TICK_INTERVAL_MS = 10 * 60 * 1000;
/** Politeness pause between calls — each one is a search + a page fetch, more work per call than OMDb's single request. */
const BETWEEN_CALL_DELAY_MS = 800;

export interface WikipediaBackfillStatus {
  totalKnown: number;
  /** Never attempted at all, successful or not. */
  neverAttempted: number;
  lastTickAt: number | null;
  lastTickProcessed: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __jellyfinGateWikipediaBackfillStatus: WikipediaBackfillStatus | undefined;
}

/** Cheap read for the Health tab — reports whatever the last tick already computed, never triggers new work itself. */
export function getWikipediaBackfillStatus(): WikipediaBackfillStatus | null {
  return globalThis.__jellyfinGateWikipediaBackfillStatus ?? null;
}

export async function runWikipediaBackfillTick(): Promise<{ processed: number }> {
  const knownFilms = await getKnownFilms().catch((error) => {
    console.error("[wikipedia-backfill] could not read movie list from Jellyfin:", error);
    return [];
  });

  const attemptedIds = new Set(
    asRows<{ film_imdb_id: string }>(
      getDb()
        .prepare("SELECT DISTINCT film_imdb_id FROM scrape_jobs WHERE source_id = 'wikipedia' AND film_imdb_id IS NOT NULL")
        .all(),
    ).map((r) => r.film_imdb_id),
  );

  const targets = knownFilms.filter((f) => !attemptedIds.has(f.imdbId)).slice(0, BATCH_SIZE);

  let processed = 0;
  for (const film of targets) {
    const job = createScrapeJob("wikipedia", film.imdbId);
    try {
      const result = await fetchWikipediaForFilm(film.name, film.year, film.imdbId);
      markScrapeJobDone(job.id, result.found ? 1 + (result.accoladeCount ?? 0) : 0, result.found ? 1 : 0);
    } catch (error) {
      markScrapeJobFailed(job.id, error instanceof Error ? error.message : String(error));
      console.error(`[wikipedia-backfill] fetch failed for "${film.name}":`, error);
    }
    processed++;
    if (processed < targets.length) await sleep(BETWEEN_CALL_DELAY_MS);
  }

  globalThis.__jellyfinGateWikipediaBackfillStatus = {
    totalKnown: knownFilms.length,
    neverAttempted: knownFilms.length - attemptedIds.size - processed,
    lastTickAt: Date.now(),
    lastTickProcessed: processed,
  };

  return { processed };
}
