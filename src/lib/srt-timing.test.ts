import assert from "node:assert/strict";
import { test } from "node:test";

import { cueAt, describeTiming, fitTwoPoints, formatMs, formatSrt, offsetFromLine, parseSrt, retime } from "./srt-timing.ts";

const SRT = "﻿1\r\n00:00:01,068 --> 00:00:03,037\r\n<i>My name is Nathan Fielder,</i>\r\n\r\n2\r\n00:00:03,136 --> 00:00:06,106\r\nand I graduated from one of\r\nCanada's top business schools\r\n\r\n\r\n";

test("reads an .srt with a BOM and Windows line endings", () => {
  const cues = parseSrt(SRT);
  assert.equal(cues.length, 2);
  assert.deepEqual(cues[0], { index: 1, startMs: 1068, endMs: 3037, text: "<i>My name is Nathan Fielder,</i>" });
  assert.equal(cues[1]!.text, "and I graduated from one of\nCanada's top business schools");
});

test("writes it back the same", () => {
  const cues = parseSrt(SRT);
  assert.deepEqual(parseSrt(formatSrt(cues)), cues);
  assert.equal(formatMs(3_723_004), "01:02:03,004");
});

test("a shift moves every line; one pushed partly before 0 starts at 0, wholly before 0 is dropped", () => {
  const moved = retime(parseSrt(SRT), { scale: 1, offsetMs: -2000 });
  assert.deepEqual(moved.map((c) => [c.index, c.startMs, c.endMs]), [
    [1, 0, 1037],
    [2, 1136, 4106],
  ]);
  assert.equal(retime(parseSrt(SRT), { scale: 1, offsetMs: -3500 }).length, 1);
});

test("the line showing at a moment, with a shift applied", () => {
  const cues = parseSrt(SRT);
  assert.equal(cueAt(cues, 2000, { scale: 1, offsetMs: 0 })?.index, 1);
  assert.equal(cueAt(cues, 2000, { scale: 1, offsetMs: 1500 }), null);
  assert.equal(cueAt(cues, 2600, { scale: 1, offsetMs: 1500 })?.index, 1);
});

test("'this line is being said now' gives the shift", () => {
  const [first] = parseSrt(SRT);
  assert.deepEqual(offsetFromLine(first!, 3500), { scale: 1, offsetMs: 2432 });
});

test("two lines heard at two moments give a stretch and a shift", () => {
  // A 25 fps subtitle on a 23.976 film: 25/23.976 slower, plus a 1 s slip.
  const scale = 25 / 23.976;
  const at = (cueMs: number) => ({ cueMs, videoMs: cueMs * scale + 1000 });
  const fit = fitTwoPoints(at(60_000), at(5_400_000));
  assert.ok(!("error" in fit));
  assert.ok(Math.abs(fit.scale - scale) < 1e-5);
  assert.ok(Math.abs(fit.offsetMs - 1000) <= 1);
  assert.match(describeTiming(fit), /^\+1\.0 s, 4\.27% slower$/);
});

test("two lines too close together, or an impossible stretch, are refused", () => {
  assert.ok("error" in fitTwoPoints({ cueMs: 0, videoMs: 0 }, { cueMs: 30_000, videoMs: 30_500 }));
  assert.ok("error" in fitTwoPoints({ cueMs: 0, videoMs: 0 }, { cueMs: 600_000, videoMs: 900_000 }));
});

test("the shift in words", () => {
  assert.equal(describeTiming({ scale: 1, offsetMs: -400 }), "−0.4 s");
  assert.equal(describeTiming({ scale: 1, offsetMs: 1250 }), "+1.3 s");
});
