/**
 * The worker's side of the site's scheduler (src/lib/scheduler.ts).
 *
 * Two things:
 *
 *  - "worker" jobs (the backup). The site decides when one is due, and
 *    whether to wait while someone is watching, and marks the job's row
 *    (run_requested: 1 = "Run now", 2 = its time came). Each cycle the worker
 *    claims what is marked, records a run in job_runs, does it, and writes
 *    how it ended. What a kind means is fixed in the worker's handler list:
 *    nothing from the database is run as a command.
 *
 *  - the worker's own loop work (conversions, the upload virus scan, the
 *    damaged-file check). Each pass that does something is recorded as a run
 *    of that loop's row, so the Health tab shows one list of what ran, when,
 *    and what it found. A pass that finds nothing to do leaves no row.
 *
 * Plain SQL against the shared database (WAL mode), as the rest of the
 * worker does. Every function takes the database, so the tests can use a
 * scratch one.
 */

import { randomUUID } from "node:crypto";

const HISTORY = 50;

function hasSchedulerTables(db) {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('scheduled_jobs', 'job_runs')")
    .get();
  return Number(row?.n ?? 0) === 2;
}

function jobExists(db, jobId) {
  return Boolean(db.prepare("SELECT 1 AS x FROM scheduled_jobs WHERE id = ?").get(jobId));
}

function startRun(db, jobId, trigger, now) {
  const id = randomUUID();
  db.prepare("INSERT INTO job_runs (id, job_id, trigger, status, started_at) VALUES (?, ?, ?, 'running', ?)").run(id, jobId, trigger, now);
  return id;
}

export function finishRun(db, runId, { summary = null, error = null }, now = Date.now()) {
  db.prepare("UPDATE job_runs SET status = ?, finished_at = ?, summary = ?, error = ? WHERE id = ? AND status = 'running'").run(
    error ? "failed" : "done",
    now,
    summary ? String(summary).slice(0, 1000) : null,
    error ? String(error).slice(0, 2000) : null,
    runId,
  );
  // A job's history is its last fifty runs, as the site keeps it.
  db.prepare(
    `DELETE FROM job_runs WHERE job_id = (SELECT job_id FROM job_runs WHERE id = ?)
        AND id NOT IN (SELECT id FROM job_runs WHERE job_id = (SELECT job_id FROM job_runs WHERE id = ?)
                       ORDER BY started_at DESC LIMIT ${HISTORY})`,
  ).run(runId, runId);
}

/**
 * At start, nothing of the worker's can still be running: there is one
 * worker process at a time, and a run belongs to the process that started
 * it. Anything the table says is running was cut off.
 */
export function failInterruptedWorkerRuns(db, now = Date.now()) {
  if (!hasSchedulerTables(db)) return 0;
  const result = db
    .prepare(
      `UPDATE job_runs SET status = 'failed', finished_at = ?, error = 'The worker stopped while this was running.'
        WHERE status = 'running' AND job_id IN (SELECT id FROM scheduled_jobs WHERE runner IN ('worker', 'loop'))`,
    )
    .run(now);
  return Number(result.changes);
}

/**
 * Claims the worker jobs the site has marked, and starts a run for each.
 * Claiming clears the mark first, so a job is never collected twice.
 */
export function collectWorkerJobs(db, now = Date.now()) {
  if (!hasSchedulerTables(db)) return [];
  const marked = db.prepare("SELECT id, kind, label, run_requested FROM scheduled_jobs WHERE runner = 'worker' AND run_requested > 0").all();
  const out = [];
  for (const job of marked) {
    // Still running from before: left marked, and collected once it ends.
    if (db.prepare("SELECT 1 AS x FROM job_runs WHERE job_id = ? AND status = 'running'").get(job.id)) continue;
    const claimed = db.prepare("UPDATE scheduled_jobs SET run_requested = 0 WHERE id = ? AND run_requested = ?").run(job.id, job.run_requested);
    if (Number(claimed.changes) !== 1) continue;
    const forced = Number(job.run_requested) === 1;
    out.push({ jobId: job.id, kind: job.kind, label: job.label, forced, runId: startRun(db, job.id, forced ? "manual" : "schedule", now) });
  }
  return out;
}

/**
 * Collects and runs the worker jobs, one after another. `handlers` maps a
 * kind to `async ({ forced }) => summary line`; a throw is recorded as the
 * run's failure.
 */
export async function runWorkerJobs(db, handlers, { log = () => {}, now = Date.now } = {}) {
  let ran = 0;
  for (const job of collectWorkerJobs(db, now())) {
    const handler = handlers[job.kind];
    if (!handler) {
      finishRun(db, job.runId, { error: `The worker does not know the job '${job.kind}'.` }, now());
      continue;
    }
    log(`job: ${job.label} starting${job.forced ? " (run by hand)" : ""}`);
    try {
      const summary = await handler({ forced: job.forced });
      finishRun(db, job.runId, { summary }, now());
      log(`job: ${job.label}: ${summary}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      finishRun(db, job.runId, { error: message }, now());
      log(`job: ${job.label} FAILED: ${message}`);
    }
    ran += 1;
  }
  return ran;
}

/**
 * Records one pass of a loop as a run of its row. `work` returns the line to
 * show, or null when it found nothing to do (the run is then forgotten).
 * Never throws: the loop's own failure is recorded and logged, and the
 * worker carries on as it did before runs were recorded.
 */
export async function recordLoopRun(db, jobId, work, { log = () => {}, now = Date.now } = {}) {
  const recording = hasSchedulerTables(db) && jobExists(db, jobId);
  const runId = recording ? startRun(db, jobId, "schedule", now()) : null;
  try {
    const summary = await work();
    if (runId) {
      if (summary == null) db.prepare("DELETE FROM job_runs WHERE id = ?").run(runId);
      else finishRun(db, runId, { summary }, now());
    }
    return summary;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (runId) finishRun(db, runId, { error: message }, now());
    log(`${jobId} failed: ${message}`);
    return null;
  }
}
