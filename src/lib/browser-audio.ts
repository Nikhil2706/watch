import "server-only";

import { asRow, getDb } from "./db";

/**
 * The reading side of the worker's browser-audio pass (scripts/browser-audio.mjs
 * has the rules, media-worker.mjs does the work): what it did to a file, and
 * the curator's "Add browser audio now", which puts the file first in the
 * worker's line whatever the day's count.
 */

export interface BrowserAudioStatus {
  status: "added" | "not_needed" | "failed" | "requested";
  detail: string | null;
  checkedAt: number;
}

export function browserAudioStatus(path: string): BrowserAudioStatus | null {
  const row = asRow<{ status: BrowserAudioStatus["status"]; detail: string | null; checked_at: number }>(
    getDb().prepare("SELECT status, detail, checked_at FROM browser_audio WHERE path = ?").get(path),
  );
  return row ? { status: row.status, detail: row.detail, checkedAt: row.checked_at } : null;
}

/** Asks the worker to look at this file next. Size and mtime of 0 make it "changed". */
export function requestBrowserAudio(path: string): void {
  getDb()
    .prepare(
      `INSERT INTO browser_audio (path, size, mtime_ms, status, detail, checked_at) VALUES (?, 0, 0, 'requested', NULL, ?)
       ON CONFLICT(path) DO UPDATE SET status = 'requested', detail = NULL, checked_at = excluded.checked_at`,
    )
    .run(path, Date.now());
}
