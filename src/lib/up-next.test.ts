/**
 * Tests for when the player offers the next episode.
 *
 * Run:
 *   node --test --experimental-strip-types \
 *        --disable-warning=ExperimentalWarning src/lib/up-next.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { CREDITS_FALLBACK_SECONDS, showUpNext, upNextFrom } from "./up-next.ts";

const BUFFY = 2711; // S01E02, 45:11

test("without a credits marker, the last 45 seconds", () => {
  assert.equal(upNextFrom(BUFFY, null), BUFFY - CREDITS_FALLBACK_SECONDS);
});

test("Jellyfin's outro start wins when there is one", () => {
  assert.equal(upNextFrom(BUFFY, 2640), 2640);
});

test("a marker outside the episode is ignored", () => {
  assert.equal(upNextFrom(BUFFY, 0), BUFFY - CREDITS_FALLBACK_SECONDS);
  assert.equal(upNextFrom(BUFFY, BUFFY + 10), BUFFY - CREDITS_FALLBACK_SECONDS);
});

test("nothing before the duration is known, or for a short clip", () => {
  assert.equal(upNextFrom(Number.NaN, null), null);
  assert.equal(upNextFrom(120, null), null);
});

test("shown from the credits on", () => {
  const base = { duration: BUFFY, ended: false, dismissed: false };
  assert.equal(showUpNext({ ...base, currentTime: 1200 }), false);
  assert.equal(showUpNext({ ...base, currentTime: BUFFY - 44 }), true);
});

test("dismissed during the credits, it comes back when the episode ends", () => {
  const base = { duration: BUFFY, currentTime: BUFFY - 20, dismissed: true };
  assert.equal(showUpNext({ ...base, ended: false }), false);
  assert.equal(showUpNext({ ...base, ended: true }), true);
});

test("still there after the end, even with the duration gone", () => {
  assert.equal(showUpNext({ duration: Number.NaN, currentTime: 0, ended: true, dismissed: false }), true);
});
