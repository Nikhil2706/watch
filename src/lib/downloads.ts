import "server-only";

import { randomUUID } from "node:crypto";

import { asRow, getDb } from "./db";
import { getFullItem } from "./jellyfin";

/**
 * Offline-download backend (Phase 3 of the Phone App Roadmap).
 *
 * A "prepared" copy of a title is produced once — by the worker, off the
 * request path, same queued-job shape as the watch-folder pipeline — and
 * cached in MEDIA_DOWNLOADS_CACHE for every future request for that title.
 * Nothing here touches the real library or triggers a Jellyfin rescan; see
 * the download_jobs table comment in schema.ts.
 */

export type DownloadStatus = "pending" | "running" | "done" | "failed";

export interface DownloadJob {
  id: string;
  jellyfin_item_id: string;
  title: string;
  source_path: string;
  output_path: string | null;
  status: DownloadStatus;
  progress: number;
  error: string | null;
  bytes_out: number | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}

export function getDownloadJob(itemId: string): DownloadJob | null {
  return (
    asRow<DownloadJob>(
      getDb().prepare("SELECT * FROM download_jobs WHERE jellyfin_item_id = ?").get(itemId),
    ) ?? null
  );
}

export class DownloadSourceError extends Error {}

/**
 * Resolves an item to its real source file path via Jellyfin's own admin
 * API — the same privileged lookup every scraper/matcher in this codebase
 * already uses (see listAllMoviesAdmin in jellyfin.ts), not something
 * exposed to the browser.
 */
async function resolveSourcePath(itemId: string): Promise<{ title: string; path: string }> {
  const item = await getFullItem(itemId);
  const name = typeof item.Name === "string" ? item.Name : "Untitled";
  const sources = Array.isArray(item.MediaSources) ? item.MediaSources : [];
  const path = sources
    .map((s) => (s && typeof s === "object" ? (s as { Path?: unknown }).Path : undefined))
    .find((p): p is string => typeof p === "string" && p.length > 0);

  if (!path) {
    throw new DownloadSourceError(`No source file path found for item ${itemId}.`);
  }
  return { title: name, path };
}

/**
 * Enqueues a download job if one doesn't already exist for this title.
 * jellyfin_item_id is UNIQUE, so a second call while a job is already
 * pending/running/done is a no-op that just returns the existing row —
 * mirrors queueTransform()'s "already queued" shape in jobs.ts.
 */
export async function queueDownload(itemId: string): Promise<DownloadJob> {
  const existing = getDownloadJob(itemId);
  if (existing) return existing;

  const { title, path } = await resolveSourcePath(itemId);

  const id = randomUUID();
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO download_jobs (id, jellyfin_item_id, title, source_path, status, progress, created_at)
       VALUES (?, ?, ?, ?, 'pending', 0, ?)
       ON CONFLICT(jellyfin_item_id) DO NOTHING`,
    )
    .run(id, itemId, title, path, now);

  // Someone else's concurrent request may have won the insert; either way,
  // read back whatever row actually exists now rather than trusting the id
  // we generated.
  return getDownloadJob(itemId)!;
}
