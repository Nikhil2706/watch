import { test } from "node:test";
import assert from "node:assert/strict";

import { evictIdleOverflow, fanOut, sweepIdle } from "./live-hub.ts";

test("fanOut skips the excepted listener and any that throw", () => {
  const got: string[] = [];
  const a = { name: "a" };
  const b = { name: "b", dead: true };
  const c = { name: "c" };
  const delivered = fanOut(
    [a, b, c],
    (l: { name: string; dead?: boolean }, m: string) => {
      if (l.dead) throw new Error("stream closed");
      got.push(`${l.name}:${m}`);
    },
    "hello",
    c,
  );
  assert.deepEqual(got, ["a:hello"]);
  assert.equal(delivered, 1);
});

interface Entry {
  owner: string;
  streams: number;
  lastSeen: number;
}
const live = (e: Entry) => ({ streams: e.streams, lastSeen: e.lastSeen });

test("sweepIdle never removes an entry with an open stream", () => {
  const m = new Map<string, Entry>([
    ["tv", { owner: "u", streams: 1, lastSeen: 0 }],
    ["old", { owner: "u", streams: 0, lastSeen: 0 }],
    ["fresh", { owner: "u", streams: 0, lastSeen: 95_000 }],
  ]);
  assert.deepEqual(sweepIdle(m, live, 90_000, 100_000), ["old"]);
  assert.deepEqual([...m.keys()], ["tv", "fresh"]);
});

test("evictIdleOverflow removes the owner's oldest idle entries, never a live one", () => {
  const m = new Map<string, Entry>([
    ["a", { owner: "u", streams: 0, lastSeen: 1 }],
    ["b", { owner: "u", streams: 1, lastSeen: 0 }],
    ["c", { owner: "u", streams: 0, lastSeen: 3 }],
    ["x", { owner: "other", streams: 0, lastSeen: 0 }],
  ]);
  // Room for one more under a cap of 3: one must go, the oldest idle one.
  assert.deepEqual(evictIdleOverflow(m, (e) => e.owner === "u", live, 3), ["a"]);
  assert.deepEqual([...m.keys()], ["b", "c", "x"]);
  assert.deepEqual(evictIdleOverflow(m, (e) => e.owner === "u", live, 5), []);
});
