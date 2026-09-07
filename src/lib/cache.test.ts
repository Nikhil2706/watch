import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { cached, invalidate, resetCaches } from "./cache.ts";

beforeEach(() => resetCaches());

/** A clock the test drives by hand, so nothing here sleeps. */
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

test("a cold read loads and returns the value", async () => {
  const c = clock();
  let calls = 0;
  const v = await cached("ns", "k", async () => (calls++, "one"), { ttlMs: 100, now: c.now });
  assert.equal(v, "one");
  assert.equal(calls, 1);
});

test("a fresh read does not call the loader again", async () => {
  const c = clock();
  let calls = 0;
  const load = async () => (calls++, "one");
  await cached("ns", "k", load, { ttlMs: 100, now: c.now });
  c.advance(50);
  const v = await cached("ns", "k", load, { ttlMs: 100, now: c.now });
  assert.equal(v, "one");
  assert.equal(calls, 1);
});

test("a stale read returns the old value immediately and refreshes behind it", async () => {
  const c = clock();
  let calls = 0;
  const load = async () => {
    calls += 1;
    return `v${calls}`;
  };
  await cached("ns", "k", load, { ttlMs: 100, staleMs: 1000, now: c.now });

  c.advance(150); // past ttl, inside stale
  const stale = await cached("ns", "k", load, { ttlMs: 100, staleMs: 1000, now: c.now });
  assert.equal(stale, "v1", "the waiting caller gets the old value, not a delay");

  await new Promise((r) => setImmediate(r)); // let the background refresh settle
  const fresh = await cached("ns", "k", load, { ttlMs: 100, staleMs: 1000, now: c.now });
  assert.equal(fresh, "v2", "the next caller sees the refreshed value");
  assert.equal(calls, 2);
});

test("many concurrent stale reads trigger only one refresh", async () => {
  const c = clock();
  let calls = 0;
  const load = async () => (calls++, `v${calls}`);
  await cached("ns", "k", load, { ttlMs: 100, staleMs: 1000, now: c.now });
  c.advance(150);

  await Promise.all(
    Array.from({ length: 8 }, () => cached("ns", "k", load, { ttlMs: 100, staleMs: 1000, now: c.now })),
  );
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 2, "one initial load plus exactly one refresh");
});

test("past the stale window the caller waits for a real load", async () => {
  const c = clock();
  let calls = 0;
  const load = async () => (calls++, `v${calls}`);
  await cached("ns", "k", load, { ttlMs: 100, staleMs: 200, now: c.now });
  c.advance(500);
  const v = await cached("ns", "k", load, { ttlMs: 100, staleMs: 200, now: c.now });
  assert.equal(v, "v2");
  assert.equal(calls, 2);
});

test("concurrent cold readers share one upstream call", async () => {
  const c = clock();
  let calls = 0;
  const load = async () => {
    calls += 1;
    await new Promise((r) => setTimeout(r, 5));
    return "shared";
  };
  const results = await Promise.all(
    Array.from({ length: 6 }, () => cached("ns", "k", load, { ttlMs: 100, now: c.now })),
  );
  assert.deepEqual(results, Array(6).fill("shared"));
  assert.equal(calls, 1, "six cold readers, one fetch");
});

test("a failed background refresh keeps serving the stale value", async () => {
  const c = clock();
  let calls = 0;
  const load = async () => {
    calls += 1;
    if (calls > 1) throw new Error("upstream down");
    return "good";
  };
  await cached("ns", "k", load, { ttlMs: 100, staleMs: 1000, now: c.now });
  c.advance(150);
  assert.equal(await cached("ns", "k", load, { ttlMs: 100, staleMs: 1000, now: c.now }), "good");
  await new Promise((r) => setImmediate(r));
  // Still stale-servable, and the failure did not propagate to anyone.
  assert.equal(await cached("ns", "k", load, { ttlMs: 100, staleMs: 1000, now: c.now }), "good");
});

test("a cold load that throws propagates, since there is nothing to serve", async () => {
  const c = clock();
  await assert.rejects(
    cached("ns", "k", async () => { throw new Error("nope"); }, { ttlMs: 100, now: c.now }),
    /nope/,
  );
});

test("a failed cold load is not cached, so the next call retries", async () => {
  const c = clock();
  let calls = 0;
  const load = async () => {
    calls += 1;
    if (calls === 1) throw new Error("blip");
    return "recovered";
  };
  await assert.rejects(cached("ns", "k", load, { ttlMs: 100, now: c.now }));
  assert.equal(await cached("ns", "k", load, { ttlMs: 100, now: c.now }), "recovered");
});

test("keys and namespaces are independent", async () => {
  const c = clock();
  await cached("a", "k", async () => "a-k", { ttlMs: 100, now: c.now });
  await cached("b", "k", async () => "b-k", { ttlMs: 100, now: c.now });
  await cached("a", "j", async () => "a-j", { ttlMs: 100, now: c.now });
  assert.equal(await cached("a", "k", async () => "changed", { ttlMs: 100, now: c.now }), "a-k");
  assert.equal(await cached("b", "k", async () => "changed", { ttlMs: 100, now: c.now }), "b-k");
  assert.equal(await cached("a", "j", async () => "changed", { ttlMs: 100, now: c.now }), "a-j");
});

test("invalidate drops one key and leaves its neighbours", async () => {
  const c = clock();
  await cached("ns", "k", async () => "one", { ttlMs: 1000, now: c.now });
  await cached("ns", "j", async () => "two", { ttlMs: 1000, now: c.now });
  invalidate("ns", "k");
  assert.equal(await cached("ns", "k", async () => "reloaded", { ttlMs: 1000, now: c.now }), "reloaded");
  assert.equal(await cached("ns", "j", async () => "changed", { ttlMs: 1000, now: c.now }), "two");
});

test("invalidate with no key drops the whole namespace", async () => {
  const c = clock();
  await cached("ns", "k", async () => "one", { ttlMs: 1000, now: c.now });
  await cached("ns", "j", async () => "two", { ttlMs: 1000, now: c.now });
  invalidate("ns");
  assert.equal(await cached("ns", "k", async () => "x", { ttlMs: 1000, now: c.now }), "x");
  assert.equal(await cached("ns", "j", async () => "y", { ttlMs: 1000, now: c.now }), "y");
});

test("staleMs of 0 means expiry is a hard edge", async () => {
  const c = clock();
  let calls = 0;
  const load = async () => (calls++, `v${calls}`);
  await cached("ns", "k", load, { ttlMs: 100, staleMs: 0, now: c.now });
  c.advance(101);
  assert.equal(await cached("ns", "k", load, { ttlMs: 100, staleMs: 0, now: c.now }), "v2");
});
