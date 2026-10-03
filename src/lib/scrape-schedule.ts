import "server-only";

import { runContentWarningBackfillTick } from "./content-warnings";
import { runOmdbBackfillTick } from "./omdb-backfill";
import { runWikipediaBackfillTick } from "./wikipedia-backfill";

/**
 * The OMDb/Wikipedia/content-notes catch-up as one bounded pass, so it only
 * does real work when asked: a curator clicking "Scrape now" in the console,
 * or the scheduled "catch-up" job (scheduler.ts; weekly by default). Left
 * unconstrained, these loops would hit OMDb and Wikipedia every 10 minutes
 * for as long as the process runs — fine politeness-wise per call, but more
 * standing background network traffic than this deployment wants by default.
 */

/** Hard stop so a very large backlog can't tie up the process indefinitely — it just picks up again next week (or on the next manual click) where it left off, since progress is tracked in scrape_jobs/rating_cache, not in this loop's own state. */
const MAX_PASS_DURATION_MS = 25 * 60 * 1000;
const BETWEEN_PASS_DELAY_MS = 1500;

declare global {
  // eslint-disable-next-line no-var
  var __jellyfinGateScrapeRunInProgress: boolean | undefined;
}

export interface ScrapePassResult {
  omdbProcessed: number;
  wikipediaProcessed: number;
  contentWarningsProcessed: number;
  passes: number;
  durationMs: number;
}

/**
 * Runs OMDb + Wikipedia backfill to exhaustion (or the time cap above)
 * instead of the single small batch each tick normally does — used by both
 * the "Scrape now" button and the scheduled job, so either path
 * actually clears the backlog rather than nibbling at a few titles.
 *
 * OMDb's own daily budget (src/lib/omdb-backfill.ts) still applies — once a
 * tick reports skippedBudget, this stops calling OMDb for the rest of the
 * pass but keeps working through Wikipedia, which has no daily cap.
 */
export async function runFullScrapePass(): Promise<ScrapePassResult> {
  if (globalThis.__jellyfinGateScrapeRunInProgress) {
    throw new Error("A scrape pass is already running.");
  }
  globalThis.__jellyfinGateScrapeRunInProgress = true;

  const startedAt = Date.now();
  let omdbTotal = 0;
  let wikipediaTotal = 0;
  let contentWarningsTotal = 0;
  let omdbExhausted = false;
  let pass = 0;

  try {
    for (;;) {
      pass++;
      let anyWork = false;

      if (!omdbExhausted) {
        const omdb = await runOmdbBackfillTick();
        omdbTotal += omdb.processed;
        if (omdb.processed > 0) anyWork = true;
        if (omdb.skippedBudget || omdb.processed === 0) omdbExhausted = true;
      }

      const wiki = await runWikipediaBackfillTick();
      wikipediaTotal += wiki.processed;
      if (wiki.processed > 0) anyWork = true;

      // No exhaustion flag like OMDb's — TMDB has no meaningful daily cap at
      // this scale, so a tick reporting 0 processed genuinely means "caught
      // up," not "budget spent," and is safe to just keep calling.
      const warnings = await runContentWarningBackfillTick();
      contentWarningsTotal += warnings.processed;
      if (warnings.processed > 0) anyWork = true;

      if (!anyWork) break;
      if (Date.now() - startedAt >= MAX_PASS_DURATION_MS) break;

      await new Promise((resolve) => setTimeout(resolve, BETWEEN_PASS_DELAY_MS));
    }
  } finally {
    globalThis.__jellyfinGateScrapeRunInProgress = false;
  }

  return {
    omdbProcessed: omdbTotal,
    wikipediaProcessed: wikipediaTotal,
    contentWarningsProcessed: contentWarningsTotal,
    passes: pass,
    durationMs: Date.now() - startedAt,
  };
}

export function isScrapeRunInProgress(): boolean {
  return globalThis.__jellyfinGateScrapeRunInProgress === true;
}

/** Called from the manual "Scrape now" trigger — always allowed, no schedule check. */
export async function runManualScrapePass(): Promise<ScrapePassResult> {
  return runFullScrapePass();
}
