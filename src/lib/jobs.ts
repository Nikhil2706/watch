import "server-only";

import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";

import { asRows, getDb } from "./db";

/**
 * Read side of the watch-folder pipeline.
 *
 * The worker (scripts/media-worker.mjs) writes these rows from a separate
 * process. That works because the database is in WAL mode: the worker's writes
 * do not block the gateway's reads, and vice versa. Without WAL the two would
 * serialise against each other and a long conversion could stall page renders.
 */

export type JobStatus =
  | "pending"
  | "running"
  // Suspended via SIGSTOP, not killed: the encode keeps every frame done so far.
  | "paused"
  | "done"
  | "failed"
  | "skipped";

export interface MediaJob {
  id: string;
  source_path: string;
  title: string;
  output_path: string | null;
  status: JobStatus;
  progress: number;
  speed: number | null;
  error: string | null;
  bytes_in: number | null;
  bytes_out: number | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}

/**
 * Titles that are being ingested right now.
 *
 * These are deliberately shown to viewers even though Jellyfin cannot play
 * them yet — a title that silently appears an hour after it was dropped in is
 * more confusing than one that says it is still processing.
 */
export function getActiveJobs(): MediaJob[] {
  return asRows<MediaJob>(
    getDb()
      .prepare(
        `SELECT * FROM media_jobs
          WHERE status IN ('pending', 'running', 'paused')
          ORDER BY created_at`,
      )
      .all(),
  );
}

/** Everything, for the admin endpoint. Failures included. */
export function listJobs(limit = 100): MediaJob[] {
  return asRows<MediaJob>(
    getDb()
      .prepare("SELECT * FROM media_jobs ORDER BY created_at DESC LIMIT ?")
      .all(limit),
  );
}

/** Human-readable one-liner for a job in progress. */
export function describeJob(job: MediaJob): string {
  if (job.status === "paused") return `Paused at ${job.progress}%`;
  if (job.status === "pending") return "Queued for conversion";
  if (job.progress > 0) {
    const speed = job.speed ? ` · ${job.speed.toFixed(1)}× realtime` : "";
    return `Converting — ${job.progress}%${speed}`;
  }
  return "Converting";
}

/* ------------------------------------------------------------------ *
 * Estimated time remaining
 * ------------------------------------------------------------------ */

/**
 * Seconds left, derived from elapsed wall time and percent complete.
 *
 * Deliberately not computed from ffmpeg's `speed` multiplier: that is the
 * instantaneous rate, and it swings hard when the encoder hits a busy scene or
 * when something else takes the CPU. Elapsed-versus-progress is self-correcting
 * — an early wild estimate converges as the job runs.
 *
 * Returns null below 1% because dividing by a rounded-to-zero progress figure
 * produces nonsense, and "calculating" is a more honest thing to show.
 */
export function etaSeconds(job: MediaJob): number | null {
  if (!job.started_at || job.progress < 1 || job.progress >= 100) return null;
  const elapsed = (Date.now() - job.started_at) / 1000;
  if (elapsed <= 0) return null;
  return Math.round((elapsed * (100 - job.progress)) / job.progress);
}

export function formatEta(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return null;
  if (seconds < 90) return "under a minute left";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `about ${minutes} min left`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `about ${hours}h left` : `about ${hours}h ${rest}m left`;
}

/**
 * Queues a pause or resume for a running conversion.
 *
 * The worker polls this table and sends SIGSTOP / SIGCONT to ffmpeg, which
 * suspends the process rather than killing it — there is no mid-file resume, so
 * killing a two-hour encode at 80% would throw all of it away.
 */
/**
 * Queues a file for the worker to convert — the gate never runs ffmpeg
 * itself (only the worker image carries it), so this writes the same row
 * shape media-worker.mjs writes when it discovers a file on its own, and
 * leaves actually converting it to whenever the worker is next started.
 *
 * source_path is UNIQUE, so a file already queued or previously processed
 * silently no-ops rather than erroring — `queued: false` tells the caller
 * that happened, so the dashboard can say "already queued" instead of
 * pretending a new job was created.
 */
export function queueTransform(path: string, title: string): { queued: boolean; jobId: string } {
  const jobId = randomUUID();
  let bytesIn: number | null = null;
  try {
    bytesIn = statSync(path).size;
  } catch {
    /* worth queuing even if the size can't be read from here */
  }

  const result = getDb()
    .prepare(
      `INSERT OR IGNORE INTO media_jobs (id, source_path, title, status, progress, created_at, bytes_in)
       VALUES (?, ?, ?, 'pending', 0, ?, ?)`,
    )
    .run(jobId, path, title, Date.now(), bytesIn);
  return { queued: Number(result.changes) > 0, jobId };
}

export function requestJobControl(jobId: string, action: "pause" | "resume"): boolean {
  const job = getDb()
    .prepare("SELECT status FROM media_jobs WHERE id = ?")
    .get(jobId) as { status: JobStatus } | undefined;
  if (!job) return false;

  const valid =
    (action === "pause" && job.status === "running") ||
    (action === "resume" && job.status === "paused");
  if (!valid) return false;

  getDb()
    .prepare(
      `INSERT INTO job_controls (job_id, action, created_at) VALUES (?, ?, ?)
       ON CONFLICT(job_id) DO UPDATE SET action = excluded.action, created_at = excluded.created_at`,
    )
    .run(jobId, action, Date.now());
  return true;
}
