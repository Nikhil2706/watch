import assert from "node:assert/strict";
import { test } from "node:test";

import { parseRange } from "./http-range.ts";

const SIZE = 1000;

test("no range header means send the whole thing", () => {
  assert.deepEqual(parseRange(null, SIZE), { kind: "full" });
  assert.deepEqual(parseRange(undefined, SIZE), { kind: "full" });
  assert.deepEqual(parseRange("", SIZE), { kind: "full" });
});

test("an ordinary closed range", () => {
  assert.deepEqual(parseRange("bytes=0-99", SIZE), { kind: "partial", start: 0, end: 99 });
  assert.deepEqual(parseRange("bytes=200-299", SIZE), { kind: "partial", start: 200, end: 299 });
});

test("an open-ended range runs to the last byte — this is what resuming sends", () => {
  // A native downloader resuming at 90% sends exactly this.
  assert.deepEqual(parseRange("bytes=900-", SIZE), { kind: "partial", start: 900, end: 999 });
  assert.deepEqual(parseRange("bytes=0-", SIZE), { kind: "partial", start: 0, end: 999 });
});

test("a suffix range is the LAST n bytes, not the first n", () => {
  assert.deepEqual(parseRange("bytes=-100", SIZE), { kind: "partial", start: 900, end: 999 });
});

test("a suffix longer than the file yields the whole file", () => {
  // Previously this computed a negative start and answered 416.
  assert.deepEqual(parseRange("bytes=-5000", SIZE), { kind: "partial", start: 0, end: 999 });
});

test("an end past the last byte is clamped, not rejected", () => {
  // The bug this module was extracted to fix: a downloader asking for more
  // than exists got 416, which reads as "the file is gone" and restarts it.
  assert.deepEqual(parseRange("bytes=0-99999", SIZE), { kind: "partial", start: 0, end: 999 });
  assert.deepEqual(parseRange("bytes=500-99999", SIZE), { kind: "partial", start: 500, end: 999 });
});

test("only a start at or past the end is genuinely unsatisfiable", () => {
  assert.deepEqual(parseRange("bytes=1000-", SIZE), { kind: "unsatisfiable" });
  assert.deepEqual(parseRange("bytes=1500-1600", SIZE), { kind: "unsatisfiable" });
  assert.deepEqual(parseRange("bytes=-0", SIZE), { kind: "unsatisfiable" });
  assert.deepEqual(parseRange("bytes=300-200", SIZE), { kind: "unsatisfiable" });
});

test("an empty file satisfies no range", () => {
  assert.deepEqual(parseRange("bytes=0-10", 0), { kind: "unsatisfiable" });
  assert.deepEqual(parseRange("bytes=-10", 0), { kind: "unsatisfiable" });
  // ...but with no header at all there is still nothing wrong with the request.
  assert.deepEqual(parseRange(null, 0), { kind: "full" });
});

test("headers we do not implement are ignored rather than refused", () => {
  // Multi-range: we only ever serve one, and the spec says send the whole
  // representation rather than fail. 416 here would break a client that was
  // merely being optimistic.
  assert.deepEqual(parseRange("bytes=0-9,20-29", SIZE), { kind: "full" });
  assert.deepEqual(parseRange("items=0-9", SIZE), { kind: "full" });
  assert.deepEqual(parseRange("bytes=abc-def", SIZE), { kind: "full" });
  assert.deepEqual(parseRange("bytes=-", SIZE), { kind: "full" });
  assert.deepEqual(parseRange("garbage", SIZE), { kind: "full" });
});

test("whitespace around the header is tolerated", () => {
  assert.deepEqual(parseRange("  bytes=0-99  ", SIZE), { kind: "partial", start: 0, end: 99 });
});

test("a single-byte file still works at both edges", () => {
  assert.deepEqual(parseRange("bytes=0-0", 1), { kind: "partial", start: 0, end: 0 });
  assert.deepEqual(parseRange("bytes=0-", 1), { kind: "partial", start: 0, end: 0 });
  assert.deepEqual(parseRange("bytes=-1", 1), { kind: "partial", start: 0, end: 0 });
  assert.deepEqual(parseRange("bytes=1-", 1), { kind: "unsatisfiable" });
});
