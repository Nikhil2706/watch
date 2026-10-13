import assert from "node:assert/strict";
import { test } from "node:test";

import { countErrors, isStale, judge } from "./file-check.mjs";

test("a healthy file says nothing, and is fine", () => {
  assert.equal(countErrors(""), 0);
  assert.deepEqual(judge({ audioErrors: 0, videoErrors: 0 }), { verdict: "ok", detail: "" });
});

test("what ffmpeg said about Dashcam is counted", () => {
  const audio =
    "[aac @ 0x7e70] channel element 0.0 is not allocated\n" +
    "[aist#0:1/aac @ 0x7e70] [dec:aac @ 0x7e70] Error submitting packet to decoder: Invalid data found when processing input\n";
  // One unreadable packet is one count, not one per line about it.
  assert.equal(countErrors(audio), 1);
  const video =
    "[h264 @ 0x74] Invalid NAL unit size (0 > 3018).\n[h264 @ 0x74] missing picture in access unit with size 3022\n";
  assert.equal(countErrors(video), 2);
});

test("a file with holes in it is damaged; one cut short at the end is not", () => {
  const dashcam = judge({ audioErrors: 9891, videoErrors: 3 });
  assert.equal(dashcam.verdict, "damaged");
  assert.equal(dashcam.detail, "9,891 unreadable stretches of sound, 3 broken pieces of picture");
  assert.equal(judge({ audioErrors: 1, videoErrors: 0 }).verdict, "minor");
  assert.equal(judge({ audioErrors: 0, videoErrors: 2 }).verdict, "minor");
  assert.equal(judge({ audioErrors: 0, videoErrors: 3 }).verdict, "damaged");
  assert.equal(judge({ audioErrors: 0, videoErrors: 0, unreadable: true }).verdict, "damaged");
});

test("a replaced file is checked again", () => {
  const row = { size: 1000, mtime_ms: 5_000_000 };
  assert.equal(isStale(row, 1000, 5_000_000.4), false);
  assert.equal(isStale(row, 1001, 5_000_000), true);
  assert.equal(isStale(row, 1000, 5_010_000), true);
  assert.equal(isStale(undefined, 1000, 5_000_000), true);
});
