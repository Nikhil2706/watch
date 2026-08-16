import "server-only";

import { generateId } from "../crypto";
import { asRow, asRows, getDb } from "../db";

/**
 * One run against one source — a web fetch (yearendlists, Wikipedia) or one
 * PDF's extraction. Mirrors media_jobs' shape on purpose, so the dashboard's
 * existing job-progress UI pattern (poll status/progress) is reused as-is.
 */

export type ScrapeJobStatus = "pending" | "running" | "done" | "failed";

export interface ScrapeJob {
  id: string;
  source_id: string;
  status: ScrapeJobStatus;
  progress: number;
  found_count: number;
  matched_count: number;
  error: string | null;
  film_imdb_id: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}

/** filmImdbId: set only for a per-film source (Wikipedia) — see the column's own comment in schema.ts. */
export function createScrapeJob(sourceId: string, filmImdbId?: string | null): ScrapeJob {
  const id = generateId();
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO scrape_jobs (id, source_id, status, progress, found_count, matched_count, film_imdb_id, created_at)
       VALUES (?, ?, 'running', 0, 0, 0, ?, ?)`,
    )
    .run(id, sourceId, filmImdbId ?? null, now);
  return {
    id,
    source_id: sourceId,
    status: "running",
    progress: 0,
    found_count: 0,
    matched_count: 0,
    error: null,
    film_imdb_id: filmImdbId ?? null,
    created_at: now,
    started_at: now,
    finished_at: null,
  };
}

export function markScrapeJobDone(id: string, foundCount: number, matchedCount: number): void {
  getDb()
    .prepare(
      `UPDATE scrape_jobs SET status = 'done', progress = 100, found_count = ?, matched_count = ?,
              started_at = COALESCE(started_at, ?), finished_at = ? WHERE id = ?`,
    )
    .run(foundCount, matchedCount, Date.now(), Date.now(), id);
}

export function markScrapeJobFailed(id: string, error: string): void {
  getDb()
    .prepare(
      `UPDATE scrape_jobs SET status = 'failed', error = ?,
              started_at = COALESCE(started_at, ?), finished_at = ? WHERE id = ?`,
    )
    .run(error.slice(0, 2000), Date.now(), Date.now(), id);
}

export function listRecentScrapeJobs(sourceId: string, limit = 10): ScrapeJob[] {
  return asRows<ScrapeJob>(
    getDb()
      .prepare("SELECT * FROM scrape_jobs WHERE source_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(sourceId, limit),
  );
}

export function getScrapeJob(id: string): ScrapeJob | undefined {
  return asRow<ScrapeJob>(getDb().prepare("SELECT * FROM scrape_jobs WHERE id = ?").get(id));
}
