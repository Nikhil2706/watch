import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";

import { parseClamscan, recoverInterrupted, scanWaitingUploads, SCAN_RETRY_MS } from "./upload-scan.mjs";

const T0 = Date.parse("2026-10-14T12:00:00Z");

/** The uploads table as schema.ts has it (no users FK: not under test). */
function freshDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE uploads (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, filename TEXT NOT NULL, quarantine_path TEXT NOT NULL,
    size_bytes INTEGER NOT NULL, status TEXT NOT NULL, scan_result TEXT, scanned_at INTEGER,
    reviewed_by TEXT, reviewed_at INTEGER, created_at INTEGER NOT NULL) STRICT`);
  return db;
}

function add(db, id, over = {}) {
  const row = { status: "uploaded", scan_result: null, scanned_at: null, created_at: T0, size_bytes: 1000, ...over };
  db.prepare(
    "INSERT INTO uploads (id, user_id, filename, quarantine_path, size_bytes, status, scan_result, scanned_at, created_at) VALUES (?, 'u1', ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, `${id}.mp4`, `/quarantine/${id}-${id}.mp4`, row.size_bytes, row.status, row.scan_result, row.scanned_at, row.created_at);
}

const get = (db, id) => ({ ...db.prepare("SELECT status, scan_result, scanned_at FROM uploads WHERE id = ?").get(id) });

/** A scanner whose verdict per file is set by the test, and which records what it was asked. */
function mockScanner(verdicts = {}, { signatures = { ok: true, detail: "", signaturesAt: T0 - 1000 }, available = true } = {}) {
  const scanned = [];
  return {
    scanned,
    available: () => available,
    ensureSignatures: async () => signatures,
    scan: async (path) => {
      scanned.push(path);
      const v = Object.entries(verdicts).find(([k]) => path.includes(k))?.[1] ?? { verdict: "clean", detail: "No threats found by ClamAV." };
      if (v instanceof Error) throw v;
      return v;
    },
  };
}

function deps(scanner, over = {}) {
  const events = [];
  const beats = [];
  let clock = T0;
  return {
    events,
    beats,
    d: {
      scanner,
      isBusy: async () => false,
      heartbeat: (info) => beats.push(info),
      logEvent: (e) => events.push(e),
      fileExists: () => true,
      now: () => clock,
      log: () => {},
      ...over,
    },
    advance: (ms) => (clock += ms),
  };
}

test("clean, infected and failed land in status / scan_result / scanned_at", async () => {
  const db = freshDb();
  add(db, "a");
  add(db, "b", { created_at: T0 + 1 });
  add(db, "c", { created_at: T0 + 2 });
  const scanner = mockScanner({
    "b-b": { verdict: "infected", detail: "Win.Test.EICAR_HDB-1" },
    "c-c": { verdict: "error", detail: "ClamAV error: Can't open file" },
  });
  const { d, events } = deps(scanner);
  const r = await scanWaitingUploads(db, d);

  assert.deepEqual(scanner.scanned, ["/quarantine/a-a.mp4", "/quarantine/b-b.mp4", "/quarantine/c-c.mp4"]); // oldest first
  assert.deepEqual(get(db, "a"), { status: "clean", scan_result: "No threats found by ClamAV.", scanned_at: T0 });
  assert.deepEqual(get(db, "b"), { status: "infected", scan_result: "Win.Test.EICAR_HDB-1", scanned_at: T0 });
  assert.deepEqual(get(db, "c"), { status: "uploaded", scan_result: "Scan failed: ClamAV error: Can't open file", scanned_at: T0 });
  assert.equal(r.scanned, 3);
  assert.equal(r.clean, 1);
  assert.equal(r.infected, 1);
  assert.equal(r.failed, 1);
});

test("an infected upload tells the curator and is never deleted or moved", async () => {
  const db = freshDb();
  add(db, "bad");
  const { d, events } = deps(mockScanner({ bad: { verdict: "infected", detail: "Win.Test.EICAR_HDB-1" } }));
  await scanWaitingUploads(db, d);
  const ev = events.find((e) => e.severity === "error");
  assert.ok(ev, "an error event for the curator");
  assert.match(ev.message, /bad\.mp4.*failed the virus scan.*Win\.Test\.EICAR_HDB-1.*reject it/);
  assert.equal(ev.detail.file, "/quarantine/bad-bad.mp4");
  // Still its row and its quarantine path; approveUpload refuses anything not 'clean'.
  assert.equal(db.prepare("SELECT quarantine_path FROM uploads WHERE id = 'bad'").get().quarantine_path, "/quarantine/bad-bad.mp4");
  assert.equal(get(db, "bad").status, "infected");
});

test("a scanner that throws counts as a failed scan, not a pass", async () => {
  const db = freshDb();
  add(db, "x");
  const { d } = deps(mockScanner({ x: new Error("spawn clamscan ENOENT") }));
  await scanWaitingUploads(db, d);
  assert.deepEqual(get(db, "x"), { status: "uploaded", scan_result: "Scan failed: spawn clamscan ENOENT", scanned_at: T0 });
});

test("a failed scan is retried after an hour, not before", async () => {
  const db = freshDb();
  add(db, "x");
  const scanner = mockScanner({ x: { verdict: "error", detail: "boom" } });
  const { d, advance } = deps(scanner);
  await scanWaitingUploads(db, d);
  advance(SCAN_RETRY_MS - 1);
  await scanWaitingUploads(db, d);
  assert.equal(scanner.scanned.length, 1);
  advance(1);
  await scanWaitingUploads(db, d);
  assert.equal(scanner.scanned.length, 2);
});

test("nothing is scanned while someone is watching, and it says so in the heartbeat", async () => {
  const db = freshDb();
  add(db, "a");
  const scanner = mockScanner();
  const { d, beats } = deps(scanner, { isBusy: async () => true });
  const r = await scanWaitingUploads(db, d);
  assert.equal(r.deferred, true);
  assert.deepEqual(scanner.scanned, []);
  assert.deepEqual(get(db, "a"), { status: "uploaded", scan_result: null, scanned_at: null });
  assert.equal(beats.at(-1).deferred, "someone is watching");
  assert.equal(beats.at(-1).waiting, 1);
});

test("someone starting to watch mid-batch stops it before the next file", async () => {
  const db = freshDb();
  add(db, "a");
  add(db, "b", { created_at: T0 + 1 });
  let checks = 0;
  const scanner = mockScanner();
  // Free for the first check (before the batch) and the first file; busy after.
  const { d } = deps(scanner, { isBusy: async () => ++checks > 2 });
  const r = await scanWaitingUploads(db, d);
  assert.deepEqual(scanner.scanned, ["/quarantine/a-a.mp4"]);
  assert.equal(r.deferred, true);
  assert.equal(get(db, "b").status, "uploaded");
});

test("no signatures: every waiting upload records why, nothing is scanned, no heartbeat", async () => {
  const db = freshDb();
  add(db, "a");
  const scanner = mockScanner({}, { signatures: { ok: false, detail: "no virus signatures yet", signaturesAt: null } });
  const { d, beats, events } = deps(scanner);
  await scanWaitingUploads(db, d);
  assert.deepEqual(scanner.scanned, []);
  assert.deepEqual(get(db, "a"), { status: "uploaded", scan_result: "Scan failed: no virus signatures yet", scanned_at: T0 });
  assert.equal(beats.length, 0);
  assert.equal(events[0].severity, "warning");
});

test("a file missing from quarantine is a failed scan", async () => {
  const db = freshDb();
  add(db, "gone");
  const scanner = mockScanner();
  const { d } = deps(scanner, { fileExists: () => false });
  await scanWaitingUploads(db, d);
  assert.deepEqual(scanner.scanned, []);
  assert.equal(get(db, "gone").scan_result, "Scan failed: the file is missing from quarantine.");
});

test("an upload cut off mid-scan becomes a failed attempt, not an immediate rescan", async () => {
  const db = freshDb();
  add(db, "a", { status: "scanning", scanned_at: T0 - 60_000 });
  const scanner = mockScanner();
  const { d } = deps(scanner);
  const r = await scanWaitingUploads(db, d);
  assert.equal(r.recovered, 1);
  assert.deepEqual(scanner.scanned, []); // waits out the retry delay from when it started
  assert.equal(get(db, "a").status, "uploaded");
  assert.match(get(db, "a").scan_result, /stopped part-way.*memory/);
  assert.equal(recoverInterrupted(db, T0), 0);
});

test("the curator's decision wins over a scan finishing late", async () => {
  const db = freshDb();
  add(db, "a");
  const scanner = mockScanner();
  scanner.scan = async () => {
    db.prepare("UPDATE uploads SET status = 'rejected' WHERE id = 'a'").run();
    return { verdict: "clean", detail: "No threats found by ClamAV." };
  };
  const { d } = deps(scanner);
  await scanWaitingUploads(db, d);
  assert.equal(get(db, "a").status, "rejected");
});

test("only waiting uploads are touched; reviewed ones are left alone", async () => {
  const db = freshDb();
  for (const status of ["clean", "infected", "approved", "rejected"]) add(db, status, { status, scan_result: "before", scanned_at: 1 });
  const scanner = mockScanner();
  const { d, beats } = deps(scanner);
  await scanWaitingUploads(db, d);
  assert.deepEqual(scanner.scanned, []);
  for (const status of ["clean", "infected", "approved", "rejected"]) assert.deepEqual(get(db, status), { status, scan_result: "before", scanned_at: 1 });
  assert.deepEqual(beats, [{ waiting: 0 }]); // alive, nothing to do
});

test("without ClamAV installed it does nothing and claims nothing", async () => {
  const db = freshDb();
  add(db, "a");
  const { d, beats } = deps(mockScanner({}, { available: false }));
  await scanWaitingUploads(db, d);
  assert.equal(get(db, "a").status, "uploaded");
  assert.deepEqual(beats, []);
});

test("parseClamscan reads clamscan's exit codes and output", () => {
  assert.deepEqual(parseClamscan({ code: 0, stdout: "", stderr: "" }), { verdict: "clean", detail: "" });
  assert.deepEqual(
    parseClamscan({ code: 1, stdout: "/quarantine/x.mp4: Win.Test.EICAR_HDB-1 FOUND\n", stderr: "" }),
    { verdict: "infected", detail: "Win.Test.EICAR_HDB-1" },
  );
  assert.equal(parseClamscan({ code: 2, stdout: "", stderr: "LibClamAV Error: cli_loaddbdir(): No supported database files found\nERROR: Can't open file or directory\n" }).detail,
    "ClamAV error: ERROR: Can't open file or directory");
  assert.match(parseClamscan({ code: null, signal: "SIGKILL", stdout: "", stderr: "" }).detail, /killed.*memory limit/);
  assert.match(parseClamscan({ code: 137, stdout: "", stderr: "" }).detail, /memory limit/);
  assert.match(parseClamscan({ code: null, signal: null, timedOut: true, timeoutMs: 7_200_000, stdout: "", stderr: "" }).detail, /longer than 120 minutes/);
  assert.equal(parseClamscan({ code: 1, stdout: "", stderr: "" }).verdict, "infected"); // found, unnamed: still not clean
});
