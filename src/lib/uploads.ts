import "server-only";

import { existsSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { asRow, asRows, getDb } from "./db";
import { env } from "./env";

/**
 * Langlois-mode uploads: quarantine -> antivirus scan -> curator approval,
 * in that order, before anything reaches MEDIA_INCOMING (and from there the
 * normal watch-folder pipeline into the real library). See the `uploads`
 * table comment in schema.ts for the full status-flow reasoning.
 *
 * The antivirus step happens OUTSIDE this app entirely: Windows Defender
 * can't be invoked from inside this Linux container, so a native
 * PowerShell script (scripts/windows/upload-scanner.ps1, run on a
 * schedule like docker-watchdog.ps1 already is) watches the quarantine
 * folder on the host side, runs MpCmdRun.exe, and drops one
 * "<upload-id>.scan-result.json" file per upload next to the quarantined
 * file. reconcileScanResults() below is the only place that reads those
 * marker files back into the database — called opportunistically whenever
 * the admin Uploads list is loaded, not on any timer of its own.
 */

export type UploadStatus = "uploaded" | "scanning" | "clean" | "infected" | "approved" | "rejected";

export interface UploadRow {
  id: string;
  user_id: string;
  filename: string;
  quarantine_path: string;
  size_bytes: number;
  status: UploadStatus;
  scan_result: string | null;
  scanned_at: number | null;
  reviewed_by: string | null;
  reviewed_at: number | null;
  created_at: number;
}

export interface UploadSummary extends UploadRow {
  username: string;
}

export function createUpload(input: {
  id: string;
  userId: string;
  filename: string;
  quarantinePath: string;
  sizeBytes: number;
}): UploadRow {
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO uploads (id, user_id, filename, quarantine_path, size_bytes, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'uploaded', ?)`,
    )
    .run(input.id, input.userId, input.filename, input.quarantinePath, input.sizeBytes, now);

  return getUpload(input.id)!;
}

export function getUpload(id: string): UploadRow | null {
  return asRow<UploadRow>(getDb().prepare("SELECT * FROM uploads WHERE id = ?").get(id)) ?? null;
}

/**
 * Marker-file shape the scanner script writes — see scripts/windows/
 * upload-scanner.ps1. Kept intentionally minimal: a status the scanner is
 * confident about, plus whatever detail it has (a threat name, or "clean").
 */
interface ScanMarker {
  status: "clean" | "infected";
  detail: string;
}

function readScanMarker(quarantinePath: string): ScanMarker | null {
  const markerPath = `${quarantinePath}.scan-result.json`;
  if (!existsSync(markerPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(markerPath, "utf8")) as Partial<ScanMarker>;
    if (parsed.status !== "clean" && parsed.status !== "infected") return null;
    return { status: parsed.status, detail: typeof parsed.detail === "string" ? parsed.detail : "" };
  } catch {
    // A marker file that fails to parse is treated as "not scanned yet"
    // rather than an error — the scanner script writes it in one shot
    // (temp file + rename), so a half-written file here would mean this
    // read raced an in-progress write, not real corruption. Retried on the
    // next reconcile.
    return null;
  }
}

/**
 * Picks up any marker files the scanner script has written since the last
 * check, updating the matching uploads row. Cheap — only looks at rows
 * still in 'uploaded' or 'scanning', a handful at most in practice.
 */
export function reconcileScanResults(): void {
  const pending = asRows<{ id: string; quarantine_path: string }>(
    getDb()
      .prepare("SELECT id, quarantine_path FROM uploads WHERE status IN ('uploaded', 'scanning')")
      .all(),
  );

  for (const row of pending) {
    const marker = readScanMarker(row.quarantine_path);
    if (!marker) continue;
    getDb()
      .prepare("UPDATE uploads SET status = ?, scan_result = ?, scanned_at = ? WHERE id = ?")
      .run(marker.status, marker.detail, Date.now(), row.id);
  }
}

export function listUploads(): UploadSummary[] {
  reconcileScanResults();
  return asRows<UploadSummary>(
    getDb()
      .prepare(
        `SELECT u.*, us.username
           FROM uploads u
           JOIN users us ON us.id = u.user_id
          ORDER BY u.created_at DESC`,
      )
      .all(),
  );
}

export class UploadReviewError extends Error {}

/**
 * Moves the quarantined file into MEDIA_INCOMING — the existing
 * watch-folder drop zone — so the normal media-worker.mjs pipeline
 * (probe, convert if needed, publish into the real library, Jellyfin
 * rescan) picks it up exactly as if a curator had dropped it in by hand.
 * No new publish logic here; this only ever hands off to the pipeline
 * that already does that safely.
 *
 * Refuses anything not marked 'clean' — an 'infected' or still-scanning
 * upload can never be approved through this function, full stop, not just
 * by the caller's own judgement.
 */
export function approveUpload(id: string, reviewedBy: string): void {
  const upload = getUpload(id);
  if (!upload) throw new UploadReviewError(`No upload with id ${id}.`);
  if (upload.status !== "clean") {
    throw new UploadReviewError(
      `Can't approve — status is "${upload.status}", not "clean". ${
        upload.status === "infected" ? "This file was flagged by the antivirus scan." : "The antivirus scan hasn't finished yet."
      }`,
    );
  }

  const destination = join(env.mediaIncomingPath, upload.filename);
  try {
    renameSync(upload.quarantine_path, destination);
  } catch (error) {
    throw new UploadReviewError(`Could not move the file into the watch folder: ${(error as Error).message}`);
  }

  getDb()
    .prepare("UPDATE uploads SET status = 'approved', reviewed_by = ?, reviewed_at = ? WHERE id = ?")
    .run(reviewedBy, Date.now(), id);
}

export function rejectUpload(id: string, reviewedBy: string): void {
  const upload = getUpload(id);
  if (!upload) throw new UploadReviewError(`No upload with id ${id}.`);
  if (upload.status === "approved") {
    throw new UploadReviewError("This upload was already approved and published — nothing left to reject.");
  }

  try {
    if (existsSync(upload.quarantine_path)) unlinkSync(upload.quarantine_path);
    const markerPath = `${upload.quarantine_path}.scan-result.json`;
    if (existsSync(markerPath)) unlinkSync(markerPath);
  } catch {
    // Best effort — the DB row moving to 'rejected' is the source of truth
    // for "this isn't going anywhere," even if a leftover file needs
    // manual cleanup later.
  }

  getDb()
    .prepare("UPDATE uploads SET status = 'rejected', reviewed_by = ?, reviewed_at = ? WHERE id = ?")
    .run(reviewedBy, Date.now(), id);
}
