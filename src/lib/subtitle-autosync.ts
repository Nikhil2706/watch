import "server-only";

import { getDb } from "./db";
import { fileOf, SyncError, videoOf } from "./subtitle-sync";

/**
 * "Sync automatically" on the sync screen: the site records the ask
 * (subtitle_autosync, v66); the worker runs alass when nobody is watching
 * (scripts/subtitle-autosync.mjs, media-worker.mjs) and writes how it went.
 * Only a subtitle file listed next to the item's video can be asked for
 * (subtitle-sync.ts fileOf), so a name is never taken as a path.
 */

export type AutosyncStatus = "requested" | "running" | "done" | "failed";

export interface Autosync {
  status: AutosyncStatus;
  detail: string | null;
  requestedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

interface Row {
  status: string;
  detail: string | null;
  requested_at: number;
  started_at: number | null;
  finished_at: number | null;
}

export async function autosyncOf(itemId: string, name: string): Promise<Autosync | null> {
  const path = await fileOf(itemId, name);
  const row = getDb()
    .prepare("SELECT status, detail, requested_at, started_at, finished_at FROM subtitle_autosync WHERE path = ?")
    .get(path) as Row | undefined;
  if (!row) return null;
  return {
    status: row.status as AutosyncStatus,
    detail: row.detail,
    requestedAt: row.requested_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export async function requestAutosync(itemId: string, name: string, now = Date.now()): Promise<Autosync> {
  const path = await fileOf(itemId, name);
  const video = await videoOf(itemId);
  const current = await autosyncOf(itemId, name);
  if (current && (current.status === "requested" || current.status === "running")) {
    throw new SyncError("That file is already waiting to be synced.");
  }
  getDb()
    .prepare(
      `INSERT INTO subtitle_autosync (path, item_id, video_path, status, detail, requested_at, started_at, finished_at)
       VALUES (?, ?, ?, 'requested', NULL, ?, NULL, NULL)
       ON CONFLICT(path) DO UPDATE SET item_id = excluded.item_id, video_path = excluded.video_path, status = 'requested',
         detail = NULL, requested_at = excluded.requested_at, started_at = NULL, finished_at = NULL`,
    )
    .run(path, itemId, video.path, now);
  return { status: "requested", detail: null, requestedAt: now, startedAt: null, finishedAt: null };
}
