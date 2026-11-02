import assert from "node:assert/strict";
import { test } from "node:test";

import type { Fetcher, KeyValueStore } from "./pending.ts";
import {
  offlineResumeSeconds,
  readWatched,
  recordWatch,
  syncWatched,
  WATCHED_KEY,
} from "./watched.ts";

function memoryStore(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

const T0 = Date.UTC(2026, 10, 2, 6, 0, 0);
const MIN = 60_000;

/** A Jellyfin behind /jf: user data per item, and every write it was sent. */
function fakeJellyfin(userData: Record<string, { Played?: boolean; LastPlayedDate?: string | null }>, offline = false) {
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  const fetcher: Fetcher = async (url, init) => {
    if (offline) throw new TypeError("Failed to fetch");
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const id = decodeURIComponent(url.split("/")[3]!.split("?")[0]!);
    if (method === "GET") return new Response(JSON.stringify(userData[id] ?? {}), { status: 200 });
    if (url.startsWith("/jf/UserPlayedItems/")) {
      const date = new URL(url, "http://x").searchParams.get("datePlayed");
      userData[id] = { Played: true, LastPlayedDate: date };
    }
    return new Response("{}", { status: 200 });
  };
  return { fetcher, calls, writes: () => calls.filter((c) => c.method === "POST") };
}

test("a position part-way is kept, and is where it resumes offline", () => {
  const store = memoryStore();
  recordWatch(store, { itemId: "buffy-1", positionSeconds: 754.6, durationSeconds: 2640, ended: false }, T0);
  assert.equal(offlineResumeSeconds(store, "buffy-1"), 754);
  assert.deepEqual(readWatched(store), [{ itemId: "buffy-1", positionTicks: 7_546_000_000, at: T0, finishedAt: null }]);
  assert.equal(offlineResumeSeconds(store, "never-played"), 0);
});

test("the report at 0:00 as playback starts does not erase where it was left", () => {
  const store = memoryStore();
  recordWatch(store, { itemId: "b", positionSeconds: 900, durationSeconds: 2640, ended: false }, T0);
  recordWatch(store, { itemId: "b", positionSeconds: 0, durationSeconds: 2640, ended: false }, T0 + MIN);
  assert.equal(offlineResumeSeconds(store, "b"), 900);
});

test("ended, or past 90%, is finished, and starts again from the top", () => {
  const store = memoryStore();
  recordWatch(store, { itemId: "a", positionSeconds: 2640, durationSeconds: 2640, ended: true }, T0);
  recordWatch(store, { itemId: "b", positionSeconds: 2400, durationSeconds: 2640, ended: false }, T0);
  for (const w of readWatched(store)) {
    assert.equal(w.finishedAt, T0, w.itemId);
    assert.equal(w.positionTicks, 0, w.itemId);
  }
});

test("finished, then started again: the finish is remembered alongside the new position", () => {
  const store = memoryStore();
  recordWatch(store, { itemId: "a", positionSeconds: 2640, durationSeconds: 2640, ended: true }, T0);
  recordWatch(store, { itemId: "a", positionSeconds: 300, durationSeconds: 2640, ended: false }, T0 + 50 * MIN);
  assert.deepEqual(readWatched(store), [{ itemId: "a", positionTicks: 3_000_000_000, at: T0 + 50 * MIN, finishedAt: T0 }]);
});

test("back online: a finish is marked played on the day it happened, and the list empties", async () => {
  const store = memoryStore();
  recordWatch(store, { itemId: "buffy-3", positionSeconds: 2640, durationSeconds: 2640, ended: true }, T0);
  const jf = fakeJellyfin({ "buffy-3": { Played: false, LastPlayedDate: null } });
  assert.equal(await syncWatched(store, jf.fetcher), 1);
  assert.deepEqual(
    jf.writes().map((w) => w.url),
    [`/jf/UserPlayedItems/buffy-3?datePlayed=${encodeURIComponent(new Date(T0).toISOString())}`],
  );
  assert.deepEqual(readWatched(store), []);
});

test("back online: a part-way position is set with when it was reached", async () => {
  const store = memoryStore();
  recordWatch(store, { itemId: "b", positionSeconds: 600, durationSeconds: 2640, ended: false }, T0);
  const jf = fakeJellyfin({ b: { LastPlayedDate: new Date(T0 - 86_400_000).toISOString() } });
  assert.equal(await syncWatched(store, jf.fetcher), 1);
  const [write] = jf.writes();
  assert.equal(write!.url, "/jf/UserItems/b/UserData");
  assert.deepEqual(write!.body, { PlaybackPositionTicks: 6_000_000_000, LastPlayedDate: new Date(T0).toISOString() });
});

test("finished then restarted offline: marked played, then the new position", async () => {
  const store = memoryStore();
  recordWatch(store, { itemId: "a", positionSeconds: 2640, durationSeconds: 2640, ended: true }, T0);
  recordWatch(store, { itemId: "a", positionSeconds: 300, durationSeconds: 2640, ended: false }, T0 + 50 * MIN);
  const jf = fakeJellyfin({ a: {} });
  assert.equal(await syncWatched(store, jf.fetcher), 2);
  assert.deepEqual(jf.writes().map((w) => w.url.split("?")[0]), ["/jf/UserPlayedItems/a", "/jf/UserItems/a/UserData"]);
});

test("something watched online since is newer: nothing is overwritten, and the entry goes", async () => {
  const store = memoryStore();
  recordWatch(store, { itemId: "b", positionSeconds: 600, durationSeconds: 2640, ended: false }, T0);
  const jf = fakeJellyfin({ b: { Played: true, LastPlayedDate: new Date(T0 + 3_600_000).toISOString() } });
  assert.equal(await syncWatched(store, jf.fetcher), 0);
  assert.equal(jf.writes().length, 0);
  assert.deepEqual(readWatched(store), []);
});

test("still offline: everything stays for the next try", async () => {
  const store = memoryStore();
  recordWatch(store, { itemId: "b", positionSeconds: 600, durationSeconds: 2640, ended: false }, T0);
  const jf = fakeJellyfin({}, true);
  assert.equal(await syncWatched(store, jf.fetcher), 0);
  assert.equal(readWatched(store).length, 1);
});

test("signed out (401): kept, not dropped", async () => {
  const store = memoryStore();
  recordWatch(store, { itemId: "b", positionSeconds: 600, durationSeconds: 2640, ended: false }, T0);
  const fetcher: Fetcher = async () => new Response("", { status: 401 });
  assert.equal(await syncWatched(store, fetcher), 0);
  assert.equal(readWatched(store).length, 1);
});

test("a report that lands during a sync is not lost with the entries sent", async () => {
  const store = memoryStore();
  recordWatch(store, { itemId: "b", positionSeconds: 600, durationSeconds: 2640, ended: false }, T0);
  const jf = fakeJellyfin({ b: {} });
  const fetcher: Fetcher = async (url, init) => {
    const r = await jf.fetcher(url, init);
    if (init?.method === "POST") {
      recordWatch(store, { itemId: "b", positionSeconds: 700, durationSeconds: 2640, ended: false }, T0 + MIN);
    }
    return r;
  };
  await syncWatched(store, fetcher);
  assert.deepEqual(readWatched(store).map((w) => w.positionTicks), [7_000_000_000]);
});

test("unreadable storage is an empty list, not an error", () => {
  const store = memoryStore();
  store.data.set(WATCHED_KEY, "{not json");
  assert.deepEqual(readWatched(store), []);
  assert.deepEqual(readWatched(null), []);
});
