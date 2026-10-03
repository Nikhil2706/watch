import "server-only";

import { generateId } from "./crypto";
import { asRow, asRows, getDb } from "./db";
import { cleanParams, getJobKind, missingParam } from "./job-kinds";
import { nextRunAt, scheduleProblem, type Cadence, type Schedule } from "./job-schedule";

/**
 * The scheduled jobs: what runs, when, and what happened last time.
 *
 * Everything is in the database on purpose. The weekly scrape used to keep
 * "already ran this week" in a variable, so a restart inside its ten-minute
 * window ran it twice and a restart just before it skipped a week. A job's
 * next run is a row here, the run in progress is a row here, and two parts of
 * the process that do not share memory (the boot loop and a console request
 * are separate module instances) agree because they read the same rows.
 */

export interface ScheduledJob {
  id: string;
  kind: string;
  label: string;
  /** JSON object of the kind's settings. */
  params: string;
  cadence: Cadence;
  hour: number;
  minute: number;
  weekday: number | null;
  month_day: number | null;
  enabled: number;
  /** Wait rather than start while someone is watching. */
  skip_if_playing: number;
  /** Came with the site; can be rescheduled and paused but not deleted. */
  builtin: number;
  runner: "gate" | "host";
  next_run_at: number;
  /** Set while a due run is being held back because someone is watching. */
  waiting_since: number | null;
  /** Host jobs only: "Run now" was pressed and the host has not collected it yet. */
  run_requested: number;
  created_at: number;
  updated_at: number;
}

export interface JobRun {
  id: string;
  job_id: string;
  trigger: "schedule" | "manual";
  status: "running" | "done" | "failed";
  started_at: number;
  finished_at: number | null;
  summary: string | null;
  error: string | null;
}

/** A run still "running" after this long was cut off — by a restart, or a host script that died. */
const STALE_RUN_MS = 6 * 60 * 60 * 1000;
/** How long a job held back by playback waits before looking again. */
const PLAYBACK_RETRY_MS = 20 * 60 * 1000;

export function scheduleOf(job: ScheduledJob): Schedule {
  return { cadence: job.cadence, hour: job.hour, minute: job.minute, weekday: job.weekday, monthDay: job.month_day };
}

export function parseParams(job: ScheduledJob): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(job.params || "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/* ------------------------------------------------------------------ *
 * Jobs
 * ------------------------------------------------------------------ */

export function listJobs(): ScheduledJob[] {
  return asRows<ScheduledJob>(
    getDb().prepare("SELECT * FROM scheduled_jobs ORDER BY builtin DESC, created_at ASC").all(),
  );
}

export function getJob(id: string): ScheduledJob | undefined {
  return asRow<ScheduledJob>(getDb().prepare("SELECT * FROM scheduled_jobs WHERE id = ?").get(id));
}

export interface JobInput {
  kind: string;
  label?: string | null;
  params?: unknown;
  schedule: Schedule;
  skipIfPlaying?: boolean;
}

export class JobError extends Error {}

function insertJob(input: JobInput & { id?: string; builtin?: boolean }): ScheduledJob {
  const kind = getJobKind(input.kind);
  if (!kind) throw new JobError("That kind of job does not exist.");
  const problem = scheduleProblem(input.schedule);
  if (problem) throw new JobError(problem);
  const params = cleanParams(kind, input.params);
  const missing = missingParam(kind, params);
  if (missing) throw new JobError(missing);

  const id = input.id ?? generateId();
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO scheduled_jobs (id, kind, label, params, cadence, hour, minute, weekday, month_day, enabled,
                                   skip_if_playing, builtin, runner, next_run_at, run_requested, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, 0, ?, ?)`,
    )
    .run(
      id,
      kind.kind,
      input.label?.trim() || kind.title?.(params) || kind.label,
      JSON.stringify(params),
      input.schedule.cadence,
      input.schedule.hour,
      input.schedule.minute,
      input.schedule.cadence === "weekly" ? input.schedule.weekday ?? 0 : null,
      input.schedule.cadence === "monthly" ? input.schedule.monthDay ?? 1 : null,
      (input.skipIfPlaying ?? kind.politeByDefault) ? 1 : 0,
      input.builtin ? 1 : 0,
      kind.runner,
      nextRunAt(input.schedule, now),
      now,
      now,
    );
  return getJob(id)!;
}

export function createJob(input: JobInput): ScheduledJob {
  return insertJob(input);
}

export interface JobPatch {
  label?: string;
  schedule?: Schedule;
  enabled?: boolean;
  skipIfPlaying?: boolean;
}

export function updateJob(id: string, patch: JobPatch): ScheduledJob | undefined {
  const job = getJob(id);
  if (!job) return undefined;

  const schedule = patch.schedule ?? scheduleOf(job);
  if (patch.schedule) {
    const problem = scheduleProblem(patch.schedule);
    if (problem) throw new JobError(problem);
  }
  const enabled = patch.enabled === undefined ? job.enabled === 1 : patch.enabled;
  // A new time, or coming back from a pause, counts from now: a job paused
  // for a month should not fire the moment it is switched back on.
  const reschedule = patch.schedule !== undefined || (enabled && job.enabled === 0);

  getDb()
    .prepare(
      `UPDATE scheduled_jobs
          SET label = ?, cadence = ?, hour = ?, minute = ?, weekday = ?, month_day = ?, enabled = ?,
              skip_if_playing = ?, next_run_at = ?, waiting_since = ?, updated_at = ?
        WHERE id = ?`,
    )
    .run(
      patch.label?.trim() || job.label,
      schedule.cadence,
      schedule.hour,
      schedule.minute,
      schedule.cadence === "weekly" ? schedule.weekday ?? 0 : null,
      schedule.cadence === "monthly" ? schedule.monthDay ?? 1 : null,
      enabled ? 1 : 0,
      patch.skipIfPlaying === undefined ? job.skip_if_playing : patch.skipIfPlaying ? 1 : 0,
      reschedule ? nextRunAt(schedule, Date.now()) : job.next_run_at,
      reschedule ? null : job.waiting_since,
      Date.now(),
      id,
    );
  return getJob(id);
}

/** Built-in jobs can be paused, never deleted: a deleted backup job is a backup that silently stops. */
export function deleteJob(id: string): "deleted" | "builtin" | "missing" {
  const job = getJob(id);
  if (!job) return "missing";
  if (job.builtin === 1) return "builtin";
  getDb().prepare("DELETE FROM scheduled_jobs WHERE id = ?").run(id);
  return "deleted";
}

/**
 * The jobs the site ships with, at the times the old hard-coded schedule and
 * cron lines ran them. Inserted once each, by a fixed id; a curator's later
 * changes to them are never overwritten.
 */
const BUILTINS: Array<JobInput & { id: string }> = [
  { id: "builtin-catchup", kind: "catchup", schedule: { cadence: "weekly", weekday: 3, hour: 5, minute: 30 } },
  { id: "builtin-tmdb", kind: "tmdb_refresh", schedule: { cadence: "weekly", weekday: 1, hour: 1, minute: 30 } },
  { id: "builtin-backup", kind: "backup", schedule: { cadence: "daily", hour: 0, minute: 0 } },
];

export function ensureBuiltinJobs(): void {
  for (const builtin of BUILTINS) {
    if (!getJob(builtin.id)) insertJob({ ...builtin, builtin: true });
  }
}

/* ------------------------------------------------------------------ *
 * Runs
 * ------------------------------------------------------------------ */

export function listRuns(jobId: string, limit = 10): JobRun[] {
  return asRows<JobRun>(
    getDb().prepare("SELECT * FROM job_runs WHERE job_id = ? ORDER BY started_at DESC LIMIT ?").all(jobId, limit),
  );
}

export function lastRun(jobId: string): JobRun | undefined {
  return listRuns(jobId, 1)[0];
}

function runningRun(jobId: string): JobRun | undefined {
  return asRow<JobRun>(
    getDb().prepare("SELECT * FROM job_runs WHERE job_id = ? AND status = 'running' LIMIT 1").get(jobId),
  );
}

function startRun(jobId: string, trigger: JobRun["trigger"]): string {
  const id = generateId();
  getDb()
    .prepare("INSERT INTO job_runs (id, job_id, trigger, status, started_at) VALUES (?, ?, ?, 'running', ?)")
    .run(id, jobId, trigger, Date.now());
  return id;
}

export function finishRun(runId: string, outcome: { summary?: string | null; error?: string | null }): void {
  getDb()
    .prepare("UPDATE job_runs SET status = ?, finished_at = ?, summary = ?, error = ? WHERE id = ? AND status = 'running'")
    .run(
      outcome.error ? "failed" : "done",
      Date.now(),
      outcome.summary?.slice(0, 1000) ?? null,
      outcome.error?.slice(0, 2000) ?? null,
      runId,
    );
  // Keep a job's history to its last fifty runs.
  getDb()
    .prepare(
      `DELETE FROM job_runs WHERE job_id = (SELECT job_id FROM job_runs WHERE id = ?)
          AND id NOT IN (SELECT id FROM job_runs WHERE job_id = (SELECT job_id FROM job_runs WHERE id = ?)
                         ORDER BY started_at DESC LIMIT 50)`,
    )
    .run(runId, runId);
}

/** Runs cut off before they could say how they ended. Called at boot and on every tick. */
export function failStaleRuns(olderThanMs: number = STALE_RUN_MS): number {
  const result = getDb()
    .prepare(
      `UPDATE job_runs SET status = 'failed', finished_at = ?, error = 'Cut off before it finished (the site restarted, or the script stopped).'
        WHERE status = 'running' AND started_at < ?`,
    )
    .run(Date.now(), Date.now() - olderThanMs);
  return Number(result.changes);
}

/**
 * At boot nothing in this process can still be running a site job, whatever
 * the table says. Host runs are left alone: the host script outlives a site
 * restart and will still report.
 */
export function failInterruptedGateRuns(): number {
  const result = getDb()
    .prepare(
      `UPDATE job_runs SET status = 'failed', finished_at = ?, error = 'The site restarted while this was running.'
        WHERE status = 'running'
          AND job_id IN (SELECT id FROM scheduled_jobs WHERE runner = 'gate')`,
    )
    .run(Date.now());
  return Number(result.changes);
}

async function someoneIsWatching(): Promise<boolean> {
  try {
    const { getActiveSessions } = await import("./jellyfin");
    return (await getActiveSessions()).playing > 0;
  } catch {
    // Jellyfin not answering is not a reason to hold every job back.
    return false;
  }
}

export type StartResult =
  | { started: true; runId: string }
  | { started: false; reason: "running" | "host" | "waiting" | "missing" };

/**
 * Starts a site job and returns at once; the work carries on in the
 * background and writes its own ending.
 *
 * A scheduled start moves the job's next run on first, so a run that takes an
 * hour is not started again by the next minute's tick, and holds back while
 * someone is watching if the job asks for that. "Run now" does neither: the
 * schedule is left as it is, and a person pressing a button has decided.
 */
export async function startJob(id: string, trigger: JobRun["trigger"]): Promise<StartResult> {
  const job = getJob(id);
  if (!job) return { started: false, reason: "missing" };
  const kind = getJobKind(job.kind);

  if (job.runner === "host" || !kind?.run) {
    if (trigger === "manual") {
      getDb().prepare("UPDATE scheduled_jobs SET run_requested = 1 WHERE id = ?").run(id);
    }
    return { started: false, reason: "host" };
  }
  if (runningRun(id)) return { started: false, reason: "running" };

  if (trigger === "schedule") {
    if (job.skip_if_playing === 1 && (await someoneIsWatching())) {
      getDb()
        .prepare("UPDATE scheduled_jobs SET next_run_at = ?, waiting_since = COALESCE(waiting_since, ?) WHERE id = ?")
        .run(Date.now() + PLAYBACK_RETRY_MS, Date.now(), id);
      return { started: false, reason: "waiting" };
    }
    getDb()
      .prepare("UPDATE scheduled_jobs SET next_run_at = ?, waiting_since = NULL WHERE id = ?")
      .run(nextRunAt(scheduleOf(job), Date.now()), id);
  }

  const runId = startRun(id, trigger);
  const run = kind.run;
  void (async () => {
    try {
      finishRun(runId, { summary: await run(parseParams(job)) });
    } catch (error) {
      console.error(`[jobs] ${job.label} failed:`, error);
      finishRun(runId, { error: error instanceof Error ? error.message : String(error) });
    }
  })();
  return { started: true, runId };
}

/** Once a minute, from the boot loop: start every site job whose time has come. */
export async function runSchedulerTick(): Promise<number> {
  failStaleRuns();
  const due = asRows<{ id: string }>(
    getDb()
      .prepare("SELECT id FROM scheduled_jobs WHERE enabled = 1 AND runner = 'gate' AND next_run_at <= ?")
      .all(Date.now()),
  );
  let started = 0;
  for (const { id } of due) {
    if ((await startJob(id, "schedule")).started) started++;
  }
  return started;
}

/* ------------------------------------------------------------------ *
 * Host jobs — collected by scripts/host-jobs.sh, once a minute
 * ------------------------------------------------------------------ */

export interface HostDue {
  runId: string;
  kind: string;
  /** "Run now" was pressed: do it even where the script would decide it is not due. */
  forced: boolean;
}

/**
 * The host jobs to run now. Each one handed out is marked as started, with
 * its next run moved on, so asking twice does not run it twice.
 */
export function collectHostJobs(): HostDue[] {
  const now = Date.now();
  const due = asRows<ScheduledJob>(
    getDb()
      .prepare(
        `SELECT * FROM scheduled_jobs
          WHERE runner = 'host' AND (run_requested = 1 OR (enabled = 1 AND next_run_at <= ?))`,
      )
      .all(now),
  );
  const out: HostDue[] = [];
  for (const job of due) {
    const forced = job.run_requested === 1;
    getDb()
      .prepare("UPDATE scheduled_jobs SET run_requested = 0, next_run_at = ? WHERE id = ?")
      .run(forced && job.next_run_at > now ? job.next_run_at : nextRunAt(scheduleOf(job), now), job.id);
    if (runningRun(job.id)) continue;
    out.push({ runId: startRun(job.id, forced ? "manual" : "schedule"), kind: job.kind, forced });
  }
  return out;
}
