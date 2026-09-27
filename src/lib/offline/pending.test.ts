import assert from "node:assert/strict";
import { test } from "node:test";

import {
  keepOffline,
  PENDING_KEY,
  readPending,
  resumePending,
  type Fetcher,
  type KeyValueStore,
} from "./pending.ts";
import type { OfflineBridge, OfflineManifest } from "./types.ts";

function memoryStore(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
  };
}

function manifest(overrides: Partial<OfflineManifest> = {}): OfflineManifest {
  return {
    itemId: "abc",
    title: "A Film",
    year: 1970,
    durationSeconds: 5400,
    status: "absent",
    progress: 0,
    ready: false,
    sizeBytes: null,
    media: { url: "/api/download/abc", contentType: "video/mp4", filename: "media.mp4" },
    poster: null,
    subtitles: [],
    ...overrides,
  };
}

function fakeBridge(): OfflineBridge & { started: OfflineManifest[] } {
  const started: OfflineManifest[] = [];
  return {
    started,
    async start(m) {
      started.push(m);
    },
    async list() {
      return [];
    },
    async remove() {},
    async localUrl() {
      return null;
    },
    async readText() {
      return null;
    },
  };
}

/** Routes each URL to a handler; records every call. */
function fakeFetch(routes: Record<string, (init?: RequestInit) => Response>): Fetcher & {
  calls: { url: string; init?: RequestInit }[];
} {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const handler = routes[url];
    if (!handler) throw new Error(`unexpected fetch ${url}`);
    return handler(init);
  }) as Fetcher & { calls: typeof calls };
  fn.calls = calls;
  return fn;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

test("a ready title goes straight to the device", async () => {
  const bridge = fakeBridge();
  const store = memoryStore();
  const fetcher = fakeFetch({
    "/api/download/abc/manifest": () => json(manifest({ status: "done", ready: true, sizeBytes: 10 })),
  });

  assert.equal(await keepOffline("abc", "A Film", { bridge, fetcher, store }), "downloading");
  assert.equal(bridge.started.length, 1);
  assert.deepEqual(readPending(store), []);
  // Never asked the media route for anything: the manifest already said ready.
  assert.equal(fetcher.calls.length, 1);
});

test("an unprepared title is queued with a one-byte request, not handed to the device", async () => {
  const bridge = fakeBridge();
  const store = memoryStore();
  const fetcher = fakeFetch({
    "/api/download/abc/manifest": () => json(manifest()),
    "/api/download/abc": () => json({ status: "pending", progress: 0 }, 202),
  });

  assert.equal(await keepOffline("abc", "A Film", { bridge, fetcher, store, now: () => 42 }), "preparing");
  assert.equal(bridge.started.length, 0, "the device downloader must not see a 202");

  const prepare = fetcher.calls.find((c) => c.url === "/api/download/abc");
  assert.equal(new Headers(prepare?.init?.headers).get("Range"), "bytes=0-0");

  const [entry] = readPending(store);
  assert.ok(entry);
  assert.equal(entry.itemId, "abc");
  assert.equal(entry.since, 42);
});

test("a previously failed title is retried when the user asks again", async () => {
  const bridge = fakeBridge();
  const store = memoryStore();
  const fetcher = fakeFetch({
    "/api/download/abc/manifest": () => json(manifest({ status: "failed" })),
    "/api/download/abc?retry=1": () => json({ status: "pending" }, 202),
  });

  assert.equal(await keepOffline("abc", "A Film", { bridge, fetcher, store }), "preparing");
  assert.equal(readPending(store)[0]?.status, "pending");
});

test("a title that became ready between the two requests is started, not parked", async () => {
  const bridge = fakeBridge();
  const store = memoryStore();
  let manifestCalls = 0;
  const fetcher = fakeFetch({
    "/api/download/abc/manifest": () =>
      json(manifestCalls++ === 0 ? manifest() : manifest({ status: "done", ready: true })),
    "/api/download/abc": () => new Response("x", { status: 206 }),
  });

  assert.equal(await keepOffline("abc", "A Film", { bridge, fetcher, store }), "downloading");
  assert.equal(bridge.started.length, 1);
});

test("resume hands over ready titles and keeps waiting on the rest", async () => {
  const bridge = fakeBridge();
  const store = memoryStore();
  store.setItem(
    PENDING_KEY,
    JSON.stringify([
      { itemId: "ready", title: "R", status: "running", progress: 90, error: null, since: 1 },
      { itemId: "slow", title: "S", status: "running", progress: 10, error: null, since: 1 },
      { itemId: "gone", title: "G", status: "pending", progress: 0, error: null, since: 1 },
    ]),
  );
  const fetcher = fakeFetch({
    "/api/download/ready/manifest": () => json(manifest({ itemId: "ready", status: "done", ready: true })),
    "/api/download/slow/manifest": () => json(manifest({ itemId: "slow", status: "running", progress: 55 })),
    "/api/download/gone/manifest": () => json({ error: "not_found" }, 404),
  });

  const left = await resumePending({ bridge, fetcher, store });

  assert.deepEqual(bridge.started.map((m) => m.itemId), ["ready"]);
  assert.deepEqual(left.map((p) => [p.itemId, p.progress]), [["slow", 55]]);
  assert.deepEqual(readPending(store), left);
});

test("a server-side failure stays listed with a reason instead of vanishing", async () => {
  const bridge = fakeBridge();
  const store = memoryStore();
  store.setItem(
    PENDING_KEY,
    JSON.stringify([{ itemId: "abc", title: "A", status: "running", progress: 5, error: null, since: 1 }]),
  );
  const fetcher = fakeFetch({
    "/api/download/abc/manifest": () => json(manifest({ status: "failed" })),
  });

  const [entry] = await resumePending({ bridge, fetcher, store });
  assert.ok(entry);
  assert.equal(entry.status, "failed");
  assert.ok(entry.error);
});

test("being offline leaves the pending list untouched", async () => {
  const bridge = fakeBridge();
  const store = memoryStore();
  const before = [{ itemId: "abc", title: "A", status: "running", progress: 5, error: null, since: 1 }];
  store.setItem(PENDING_KEY, JSON.stringify(before));
  const fetcher: Fetcher = async () => {
    throw new TypeError("Failed to fetch");
  };

  assert.deepEqual(await resumePending({ bridge, fetcher, store }), before);
});

test("corrupt storage reads as empty rather than throwing", () => {
  const store = memoryStore();
  store.setItem(PENDING_KEY, "{not json");
  assert.deepEqual(readPending(store), []);
  assert.deepEqual(readPending(null), []);
});
