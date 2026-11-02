import assert from "node:assert/strict";
import { test } from "node:test";

import { burnedStartJump, MAX_GAP_SECONDS } from "./burned-start-gap.ts";

test("Angel at 30 s, video from 39.6 s: move to where it begins", () => {
  assert.equal(burnedStartJump({ currentTime: 30, readyState: 1, buffered: [[39.6, 90.5]] }), 39.65);
});

test("playing normally: left alone", () => {
  assert.equal(burnedStartJump({ currentTime: 45, readyState: 4, buffered: [[39.6, 90.5]] }), null);
});

test("buffering inside what it has: left alone", () => {
  assert.equal(burnedStartJump({ currentTime: 45, readyState: 2, buffered: [[39.6, 90.5]] }), null);
});

test("nothing buffered yet (the transcode is starting): wait", () => {
  assert.equal(burnedStartJump({ currentTime: 30, readyState: 0, buffered: [] }), null);
});

test("a gap longer than this kind: left alone", () => {
  assert.equal(burnedStartJump({ currentTime: 30, readyState: 1, buffered: [[30 + MAX_GAP_SECONDS + 1, 200]] }), null);
});

test("an old range behind, the new stream ahead: the one ahead", () => {
  assert.equal(burnedStartJump({ currentTime: 600, readyState: 1, buffered: [[0, 120], [612.4, 650]] }), 612.45);
});
