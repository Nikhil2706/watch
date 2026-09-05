/**
 * Tests for missing-episode detection.
 *
 * Run:
 *   node --test --experimental-strip-types \
 *        --disable-warning=ExperimentalWarning src/lib/episode-gaps.test.ts
 *
 * Same reasoning as browse-filters.test.ts: episode-gaps.ts has no runtime
 * imports precisely so this file can load it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { episodeGaps } from "./episode-gaps.ts";

test("reports nothing for a complete season", () => {
  assert.deepEqual(episodeGaps([1, 2, 3, 4, 5]), []);
});

test("finds a single hole", () => {
  assert.deepEqual(episodeGaps([1, 2, 4, 5]), [3]);
});

test("finds several holes, including a run", () => {
  assert.deepEqual(episodeGaps([1, 4, 5, 8]), [2, 3, 6, 7]);
});

test("does not care what order the files came in", () => {
  assert.deepEqual(episodeGaps([5, 1, 4, 2]), [3]);
});

test("a season that does not start at 1 is not a gap", () => {
  // Half a show on disk is a normal state for this library — only the holes
  // between what is here are knowable, so 1 and 2 are not reported missing.
  assert.deepEqual(episodeGaps([3, 4, 5]), []);
});

test("says nothing about a season that stops early", () => {
  // 22 episodes exist upstream; nothing local can know that.
  assert.deepEqual(episodeGaps([1, 2, 3]), []);
});

test("ignores files with no episode number at all", () => {
  // Extras and specials parse to null and must not be read as episode 0.
  assert.deepEqual(episodeGaps([1, null, 3, null]), [2]);
});

test("needs at least two numbered episodes to say anything", () => {
  assert.deepEqual(episodeGaps([]), []);
  assert.deepEqual(episodeGaps([7]), []);
  assert.deepEqual(episodeGaps([null, null]), []);
});

test("tolerates a duplicate episode number", () => {
  // Two files claiming E02 (a duplicate rip) must not turn E03 into a gap.
  assert.deepEqual(episodeGaps([1, 2, 2, 3]), []);
});
