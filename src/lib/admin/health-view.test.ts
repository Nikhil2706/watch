import { test } from "node:test";
import assert from "node:assert/strict";

import {
  apiRow,
  eventDetail,
  eventsQuery,
  fmtAgo,
  fmtBytes,
  healthCards,
  issues,
  lastLine,
  nextLine,
  shouldPoll,
  storageRows,
  whenBody,
  whenFormFrom,
  type Health,
  type Job,
} from "./health-view.ts";

const NOW = Date.UTC(2026, 9, 15, 6, 0);

const base: Health = {
  overall: "ok",
  checkedAt: NOW,
  publicSite: { reachable: true, responseMs: 320 },
  jellyfin: { reachable: true, responseMs: 12, version: "10.11.11" },
  sessions: { playing: 1, signedIn: 3 },
  storage: { freeBytes: 3.9e12, totalBytes: 6e12, freeFraction: 0.65 },
  conversionQueue: { pending: 0, running: 0, failedRecent: 0, stuck: [] },
  scraping: { recentFailures: [] },
  lastLibraryScan: { triggeredAt: NOW - 3 * 3600e3 },
  database: { sizeBytes: 356e6 },
};

test("times and sizes read as before", () => {
  assert.equal(fmtAgo(null, NOW), "never");
  assert.equal(fmtAgo(NOW - 20e3, NOW), "just now");
  assert.equal(fmtAgo(NOW - 5 * 60e3, NOW), "5 min ago");
  assert.equal(fmtAgo(NOW - 3 * 3600e3, NOW), "3 hr ago");
  assert.equal(fmtAgo(NOW - 3 * 86400e3, NOW), "3 days ago");
  assert.equal(fmtBytes(356e6), "340 MB");
  assert.equal(fmtBytes(1536), "1.5 KB");
  assert.equal(fmtBytes(null), "—");
});

test("cards: a healthy site is all green", () => {
  const cards = healthCards(base, NOW);
  assert.deepEqual(
    cards.map((c) => [c.label, c.status]),
    [
      ["Public site", "ok"],
      ["Jellyfin", "ok"],
      ["Viewers now", "ok"],
      ["Storage free", "ok"],
      ["Conversion queue", "ok"],
      ["Accolades scraping", "ok"],
      ["Last library scan", ""],
      ["Database size", ""],
    ],
  );
  assert.equal(cards[2]!.value, "1 streaming");
});

test("cards: an unreachable Jellyfin, low storage and a stuck job say so", () => {
  const h: Health = {
    ...base,
    jellyfin: { reachable: false, error: "ECONNREFUSED" },
    sessions: null,
    storage: { freeBytes: 5e11, totalBytes: 6e12, freeFraction: 0.08 },
    conversionQueue: { pending: 2, running: 1, failedRecent: 1, stuck: [{ title: "Film", hoursRunning: 9 }] },
    uploadScanner: { lastRunAt: null, waiting: 1, stalled: true, infected: 1 },
  };
  const byLabel = Object.fromEntries(healthCards(h, NOW).map((c) => [c.label, c]));
  assert.equal(byLabel["Jellyfin"]!.status, "critical");
  assert.equal(byLabel["Jellyfin"]!.sub, "ECONNREFUSED");
  assert.equal(byLabel["Viewers now"]!.value, "—");
  assert.equal(byLabel["Storage free"]!.status, "critical");
  assert.equal(byLabel["Conversion queue"]!.status, "critical");
  assert.equal(byLabel["Conversion queue"]!.value, "3");
  assert.equal(byLabel["Upload scanner"]!.status, "warning");
  assert.match(byLabel["Upload scanner"]!.sub, /waiting and nothing is scanning them.*reject it in Uploads/);
  assert.deepEqual(issues(h, NOW), [{ title: "Stuck conversion: Film", meta: "Running 9 hours — check the Worker tab" }]);
});

test("storage bars are relative to the biggest", () => {
  const rows = storageRows({ scrapedDataBytes: 100, cachedApiDataBytes: 50, otherDataBytes: 0, codebaseBytes: 25 });
  assert.deepEqual(
    rows.map((r) => r.percent),
    [100, 50, 0, 25],
  );
});

test("API rows warn near the daily cap", () => {
  assert.deepEqual(apiRow({ source: "omdb", successCount: 950, failureCount: 10, dailyCap: 1000 }), {
    source: "omdb",
    percent: 96,
    level: "crit",
    text: "960 / 1000 today · 10 failed",
  });
  assert.equal(apiRow({ source: "wikipedia", successCount: 1, failureCount: 0, dailyCap: null }).text, "1 call today");
});

const job = (over: Partial<Job> = {}): Job => ({
  id: "j",
  kind: "backup",
  label: "Backup",
  description: "",
  schedule: { cadence: "weekly", hour: 1, minute: 30, weekday: 0 },
  scheduleText: "Every Sunday at 1:30 am",
  enabled: true,
  skipIfPlaying: true,
  builtin: true,
  runner: "gate",
  nextRunAt: NOW + 3600e3,
  waitingSince: null,
  runRequested: false,
  running: false,
  runs: [],
  ...over,
});

test("a job's next and last lines", () => {
  assert.equal(nextLine(job({ enabled: false })).text, "Paused");
  assert.equal(nextLine(job({ waitingSince: NOW })).tone, "wait");
  assert.equal(nextLine(job({ runner: "loop" })).text, "Runs whenever there is work");
  assert.deepEqual(lastLine(job(), NOW), { tone: "", head: "", rest: "Has not run yet" });
  const failed = job({
    runs: [{ id: "r", trigger: "manual", status: "failed", started_at: NOW - 120e3, finished_at: NOW, summary: null, error: "disk full" }],
  });
  assert.deepEqual(lastLine(failed, NOW), { tone: "bad", head: "Failed", rest: " 2 min ago, run by hand: disk full" });
  const running = job({
    running: true,
    runs: [{ id: "r", trigger: "schedule", status: "running", started_at: NOW - 60e3, finished_at: null, summary: null, error: null }],
  });
  assert.equal(lastLine(running, NOW).head, "Running now");
  assert.equal(shouldPoll([job(), running]), true);
  assert.equal(shouldPoll([job()]), false);
});

test("the when form round-trips to the API's body", () => {
  const f = whenFormFrom({ cadence: "monthly", hour: 7, minute: 5, monthDay: 15 });
  assert.equal(f.time, "07:05");
  assert.deepEqual(whenBody(f), { cadence: "monthly", hour: 7, minute: 5, weekday: 4, month_day: 15 });
  assert.equal(whenFormFrom(null).cadence, "weekly");
});

test("log detail and query", () => {
  assert.equal(eventDetail({ severity: "error", source: "x", message: "m", created_at: 0, detail: '{"a":1}', username: "u" }), '{\n  "a": 1\n}\n\nuser: u');
  assert.equal(eventDetail({ severity: "error", source: "x", message: "m", created_at: 0, detail: null }), "");
  assert.equal(eventsQuery("playback", ""), "/api/admin/events?category=playback&limit=40");
});
