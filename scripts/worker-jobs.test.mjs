import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";

import { collectWorkerJobs, failInterruptedWorkerRuns, recordLoopRun, runWorkerJobs } from "./worker-jobs.mjs";

const T0 = Date.parse("2026-10-14T18:30:00Z");

/** scheduled_jobs and job_runs as schema.ts has them. */
function freshDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`CREATE TABLE scheduled_jobs (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, label TEXT NOT NULL, params TEXT NOT NULL DEFAULT '{}',
    cadence TEXT NOT NULL, hour INTEGER NOT NULL, minute INTEGER NOT NULL, weekday INTEGER, month_day INTEGER,
    enabled INTEGER NOT NULL DEFAULT 1, skip_if_playing INTEGER NOT NULL DEFAULT 0, builtin INTEGER NOT NULL DEFAULT 0,
    runner TEXT NOT NULL DEFAULT 'gate', next_run_at INTEGER NOT NULL, waiting_since INTEGER,
    run_requested INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL) STRICT`);
  db.exec(`CREATE TABLE job_runs (
    id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES scheduled_jobs(id) ON DELETE CASCADE,
    trigger TEXT NOT NULL, status TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER,
    summary TEXT, error TEXT) STRICT`);
  const add = db.prepare(
    "INSERT INTO scheduled_jobs (id, kind, label, cadence, hour, minute, runner, next_run_at, run_requested, created_at, updated_at) VALUES (?, ?, ?, 'daily', 0, 0, ?, 0, ?, 0, 0)",
  );
  add.run("builtin-backup", "backup", "Backup", "worker", 0);
  add.run("builtin-catchup", "catchup", "Catch-up", "gate", 0);
  add.run("builtin-loop-file-check", "loop_file_check", "Damaged-file check", "loop", 0);
  return db;
}

const mark = (db, id, value) => db.prepare("UPDATE scheduled_jobs SET run_requested = ? WHERE id = ?").run(value, id);
const runs = (db, id) => db.prepare("SELECT trigger, status, summary, error FROM job_runs WHERE job_id = ? ORDER BY started_at").all(id).map((r) => ({ ...r }));

test("nothing marked, nothing collected", () => {
  assert.deepEqual(collectWorkerJobs(freshDb(), T0), []);
});

test("a job marked by the site is collected once, with a run recorded", () => {
  const db = freshDb();
  mark(db, "builtin-backup", 2);
  const got = collectWorkerJobs(db, T0);
  assert.equal(got.length, 1);
  assert.equal(got[0].kind, "backup");
  assert.equal(got[0].forced, false);
  assert.deepEqual(runs(db, "builtin-backup"), [{ trigger: "schedule", status: "running", summary: null, error: null }]);
  assert.deepEqual(collectWorkerJobs(db, T0), []);
});

test("Run now is collected as forced", () => {
  const db = freshDb();
  mark(db, "builtin-backup", 1);
  const [job] = collectWorkerJobs(db, T0);
  assert.equal(job.forced, true);
  assert.equal(runs(db, "builtin-backup")[0].trigger, "manual");
});

test("only worker jobs: the site's own and the loops are not collected", () => {
  const db = freshDb();
  mark(db, "builtin-catchup", 1);
  mark(db, "builtin-loop-file-check", 1);
  assert.deepEqual(collectWorkerJobs(db, T0), []);
});

test("a request made while a run is still going waits for it, rather than being lost", () => {
  const db = freshDb();
  mark(db, "builtin-backup", 2);
  const [first] = collectWorkerJobs(db, T0);
  mark(db, "builtin-backup", 1);
  assert.deepEqual(collectWorkerJobs(db, T0), []);
  db.prepare("UPDATE job_runs SET status = 'done' WHERE id = ?").run(first.runId);
  assert.equal(collectWorkerJobs(db, T0).length, 1);
});

test("runs each job by its kind and records how it ended", async () => {
  const db = freshDb();
  mark(db, "builtin-backup", 1);
  let asked;
  await runWorkerJobs(db, {
    backup: async ({ forced }) => {
      asked = forced;
      return "Backup taken and read back. 1 older one(s) removed.";
    },
  });
  assert.equal(asked, true);
  assert.deepEqual(runs(db, "builtin-backup"), [
    { trigger: "manual", status: "done", summary: "Backup taken and read back. 1 older one(s) removed.", error: null },
  ]);

  mark(db, "builtin-backup", 2);
  await runWorkerJobs(db, {
    backup: async () => {
      throw new Error("Backup taken, but it could not be read back, so the older ones are kept.");
    },
  });
  assert.equal(runs(db, "builtin-backup")[1].status, "failed");
  assert.match(runs(db, "builtin-backup")[1].error, /could not be read back/);
});

test("a kind the worker does not know fails its run instead of running anything", async () => {
  const db = freshDb();
  mark(db, "builtin-backup", 1);
  await runWorkerJobs(db, {});
  assert.match(runs(db, "builtin-backup")[0].error, /does not know the job 'backup'/);
});

test("a loop pass that did something is recorded; one that found nothing leaves no row", async () => {
  const db = freshDb();
  await recordLoopRun(db, "builtin-loop-file-check", async () => null);
  assert.deepEqual(runs(db, "builtin-loop-file-check"), []);
  await recordLoopRun(db, "builtin-loop-file-check", async () => "12 read through, 1 damaged (Hush.mkv), 300 still to do");
  assert.deepEqual(runs(db, "builtin-loop-file-check"), [
    { trigger: "schedule", status: "done", summary: "12 read through, 1 damaged (Hush.mkv), 300 still to do", error: null },
  ]);
});

test("a loop pass that throws is recorded as failed and does not stop the worker", async () => {
  const db = freshDb();
  const r = await recordLoopRun(db, "builtin-loop-file-check", async () => {
    throw new Error("ffmpeg not found");
  });
  assert.equal(r, null);
  assert.equal(runs(db, "builtin-loop-file-check")[0].status, "failed");
});

test("with an older site (no row for the loop) the work still runs, unrecorded", async () => {
  const db = freshDb();
  let ran = false;
  await recordLoopRun(db, "builtin-loop-conversions", async () => {
    ran = true;
    return "converted X";
  });
  assert.equal(ran, true);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM job_runs").get().n, 0);
});

test("at start, the worker's runs left 'running' were cut off; the site's are not touched", () => {
  const db = freshDb();
  const add = db.prepare("INSERT INTO job_runs (id, job_id, trigger, status, started_at) VALUES (?, ?, 'schedule', 'running', 0)");
  add.run("a", "builtin-backup");
  add.run("b", "builtin-loop-file-check");
  add.run("c", "builtin-catchup");
  assert.equal(failInterruptedWorkerRuns(db, T0), 2);
  assert.equal(db.prepare("SELECT status FROM job_runs WHERE id = 'c'").get().status, "running");
});
