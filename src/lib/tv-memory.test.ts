import assert from "node:assert/strict";
import { test } from "node:test";

import {
  cameByInAppNavigation,
  DEFAULT_TV_BACK_BUFFER_SECONDS,
  MAX_BACK_BUFFER_SECONDS,
  MIN_BACK_BUFFER_SECONDS,
  tvBackBufferSeconds,
} from "./tv-memory.ts";

test("a standard-definition transcode keeps about a quarter of an hour", () => {
  // Angel on the TV, 2026-11-02: about 1 Mbit/s, so 100 MB is fourteen minutes.
  assert.equal(tvBackBufferSeconds(1_000_000), 838);
  // Lower still and the fifteen-minute ceiling holds.
  assert.equal(tvBackBufferSeconds(500_000), MAX_BACK_BUFFER_SECONDS);
  // 2 Mbit/s: 100 MB is just under seven minutes.
  assert.equal(tvBackBufferSeconds(2_000_000), 419);
});

test("a 1080p transcode keeps under two minutes", () => {
  assert.equal(tvBackBufferSeconds(8_000_000), 104);
});

test("never under a minute, however high the bitrate", () => {
  assert.equal(tvBackBufferSeconds(40_000_000), MIN_BACK_BUFFER_SECONDS);
});

test("an unknown bitrate keeps the minimum", () => {
  for (const b of [null, undefined, 0, -5, Number.NaN]) assert.equal(tvBackBufferSeconds(b), DEFAULT_TV_BACK_BUFFER_SECONDS);
});

test("a page opened in-app is told apart from one loaded fresh", () => {
  const home = "https://watch.example/";
  const watch = "https://watch.example/watch/abc";
  assert.equal(cameByInAppNavigation(home, watch), true);
  assert.equal(cameByInAppNavigation(watch, watch), false);
  // A changed query (?sub=, ?t=) is a different page: the reload is what applies it.
  assert.equal(cameByInAppNavigation(`${watch}?t=30`, `${watch}?t=60`), true);
  // The hash alone is not a navigation.
  assert.equal(cameByInAppNavigation(watch, `${watch}#comment`), false);
  assert.equal(cameByInAppNavigation(null, watch), false);
  assert.equal(cameByInAppNavigation("not a url", watch), false);
});
