/**
 * Tests for season/episode marker detection.
 *
 * Run:
 *   node --test --experimental-strip-types \
 *        --disable-warning=ExperimentalWarning src/lib/episode-markers.test.ts
 *
 * Every filename below is a real one from this library. Two of these shapes
 * were silently unsupported until E.R. was grouped: "03x02" matched nothing at
 * all (43 files), and "s01e01e02" matched nothing either, because the plain
 * S00E00 pattern's trailing word boundary fails against the second E.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { findEpisodeMarker } from "./episode-markers.ts";

test("reads the ordinary SxxEyy form", () => {
  const m = findEpisodeMarker("er.s01e03.Day.One.fs");
  assert.equal(m.season, 1);
  assert.equal(m.episode, 3);
});

test("reads a two-digit season and episode", () => {
  const m = findEpisodeMarker("er.s13e22.the.honeymoon.is.over");
  assert.equal(m.season, 13);
  assert.equal(m.episode, 22);
});

test("reads the NNxNN form", () => {
  const m = findEpisodeMarker("03x02 - Let the Games Begin");
  assert.equal(m.season, 3);
  assert.equal(m.episode, 2);
});

test("reads NNxNN without a leading zero", () => {
  const m = findEpisodeMarker("3x7 - Ghosts");
  assert.equal(m.season, 3);
  assert.equal(m.episode, 7);
});

test("a double episode is filed under the first of the pair", () => {
  // "s01e01e02" used to parse as nothing: S01E01 is in there, but the
  // pattern's trailing boundary fails against the E02 that follows.
  const m = findEpisodeMarker("er.s01e01e02.24.hours.fs");
  assert.equal(m.season, 1);
  assert.equal(m.episode, 1);
});

test("falls back to a bare episode number", () => {
  const m = findEpisodeMarker("Out 1 - Ep 4");
  assert.equal(m.season, null);
  assert.equal(m.episode, 4);
});

test("reports nothing when there is no marker", () => {
  const m = findEpisodeMarker("Black Sabbath 1963 1080p BluRay");
  assert.equal(m.season, null);
  assert.equal(m.episode, null);
});

test("endIndex points past the marker so the title can be taken after it", () => {
  const stem = "03x02 - Let the Games Begin";
  const m = findEpisodeMarker(stem);
  assert.equal(stem.slice(m.endIndex), " - Let the Games Begin");
});

test("a resolution is not mistaken for a season and episode", () => {
  // "1920x1080" must not read as season 1920 / episode 1080 — the season
  // group caps at two digits, so the match cannot start at the beginning.
  const m = findEpisodeMarker("some.film.1920x1080.bluray");
  assert.notEqual(m.season, 1920);
});
