import assert from "node:assert/strict";
import { test } from "node:test";

import { removeLibraryScanTriggers, type JellyfinCall, type JellyfinTask } from "./jellyfin-scan-trigger.ts";

/** Jellyfin's task API as far as this needs it, recording every call. */
function mockJellyfin(tasks: JellyfinTask[]) {
  const calls: Array<{ path: string; method: string; body?: unknown }> = [];
  const call = (async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const method = init.method ?? "GET";
    calls.push({ path, method, body: init.body });
    if (method === "GET" && path.startsWith("/ScheduledTasks")) return structuredClone(tasks);
    const m = path.match(/^\/ScheduledTasks\/([^/]+)\/Triggers$/);
    if (method === "POST" && m) {
      const task = tasks.find((t) => t.Id === decodeURIComponent(m[1] ?? ""));
      if (!task) throw new Error("404");
      task.Triggers = init.body as JellyfinTask["Triggers"];
      return undefined;
    }
    throw new Error(`unexpected ${method} ${path}`);
  }) as JellyfinCall;
  return { call, calls, tasks };
}

const SCAN_TASK = (): JellyfinTask => ({
  Id: "7738148ffcd07979c7ceb148e06b3aed",
  Key: "RefreshLibrary",
  Name: "Scan Media Library",
  Triggers: [{ Type: "IntervalTrigger", IntervalTicks: 432_000_000_000 }],
});
const OTHER_TASK = (): JellyfinTask => ({
  Id: "other",
  Key: "CleanTranscodeFolder",
  Triggers: [{ Type: "DailyTrigger", TimeOfDayTicks: 0 }],
});

test("removes the 12-hour interval trigger from Scan Media Library", async () => {
  const jf = mockJellyfin([OTHER_TASK(), SCAN_TASK()]);
  const r = await removeLibraryScanTriggers(jf.call);
  assert.deepEqual(r, { changed: true, removed: ["IntervalTrigger"] });
  const post = jf.calls.find((c) => c.method === "POST");
  assert.equal(post?.path, "/ScheduledTasks/7738148ffcd07979c7ceb148e06b3aed/Triggers");
  assert.deepEqual(post?.body, []);
  assert.deepEqual(jf.tasks[1]?.Triggers, []);
});

test("leaves every other task's schedule alone", async () => {
  const jf = mockJellyfin([OTHER_TASK(), SCAN_TASK()]);
  await removeLibraryScanTriggers(jf.call);
  assert.deepEqual(jf.tasks[0]?.Triggers, [{ Type: "DailyTrigger", TimeOfDayTicks: 0 }]);
  assert.equal(jf.calls.filter((c) => c.method === "POST").length, 1);
});

test("any trigger that would scan unattended goes, not only the interval", async () => {
  const task = SCAN_TASK();
  task.Triggers = [{ Type: "IntervalTrigger" }, { Type: "StartupTrigger" }, { Type: "WeeklyTrigger", DayOfWeek: "Sunday" }];
  const jf = mockJellyfin([task]);
  const r = await removeLibraryScanTriggers(jf.call);
  assert.deepEqual(r, { changed: true, removed: ["IntervalTrigger", "StartupTrigger", "WeeklyTrigger"] });
  assert.deepEqual(jf.tasks[0]?.Triggers, []);
});

test("at the next boot there is nothing to remove, and nothing is written", async () => {
  const jf = mockJellyfin([SCAN_TASK()]);
  await removeLibraryScanTriggers(jf.call);
  const again = await removeLibraryScanTriggers(jf.call);
  assert.deepEqual(again, { changed: false, reason: "no_triggers" });
  assert.equal(jf.calls.filter((c) => c.method === "POST").length, 1);
});

test("a Jellyfin without the task: nothing is written", async () => {
  const jf = mockJellyfin([OTHER_TASK()]);
  assert.deepEqual(await removeLibraryScanTriggers(jf.call), { changed: false, reason: "no_task" });
  assert.equal(jf.calls.filter((c) => c.method === "POST").length, 0);
});

test("Jellyfin not answering is an error for the caller to retry", async () => {
  const call = (async () => {
    throw new Error("Could not reach Jellyfin");
  }) as JellyfinCall;
  await assert.rejects(removeLibraryScanTriggers(call), /Could not reach Jellyfin/);
});
