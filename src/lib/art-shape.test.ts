import assert from "node:assert/strict";
import { test } from "node:test";

import { isWideArt, prefersStillLayout, WIDE_ART_THRESHOLD } from "./art-shape.ts";

/**
 * The numbers here are the real ones: measured across the live library's 1,159
 * items, artwork clusters at ~0.667 (film posters), 1.333 (4:3 episode stills,
 * which is what TheTVDB supplies for older series) and 1.778 (16:9).
 */

test("a film poster is not wide", () => {
  assert.equal(isWideArt({ PrimaryImageAspectRatio: 0.6669802445907808 }), false);
});

test("a 4:3 episode still is wide — this is the case that was being cropped", () => {
  assert.equal(isWideArt({ PrimaryImageAspectRatio: 1.3333333333333333 }), true);
});

test("a 16:9 episode still is wide", () => {
  assert.equal(isWideArt({ PrimaryImageAspectRatio: 1.7777777777777777 }), true);
});

test("missing aspect ratio is not wide, so unknown artwork stays a poster", () => {
  assert.equal(isWideArt({}), false);
  assert.equal(isWideArt({ PrimaryImageAspectRatio: undefined }), false);
});

test("a nonsense aspect ratio is not wide rather than throwing", () => {
  assert.equal(isWideArt({ PrimaryImageAspectRatio: 0 }), false);
  assert.equal(isWideArt({ PrimaryImageAspectRatio: -2 }), false);
  assert.equal(isWideArt({ PrimaryImageAspectRatio: Number.NaN }), false);
  // Infinity is broken metadata, not an infinitely wide image — fall back to
  // the poster shape rather than letting it drag a whole row landscape.
  assert.equal(isWideArt({ PrimaryImageAspectRatio: Number.POSITIVE_INFINITY }), false);
});

test("the threshold itself counts as wide", () => {
  assert.equal(isWideArt({ PrimaryImageAspectRatio: WIDE_ART_THRESHOLD }), true);
  assert.equal(isWideArt({ PrimaryImageAspectRatio: WIDE_ART_THRESHOLD - 0.001 }), false);
});

test("an empty row keeps the poster layout", () => {
  assert.equal(prefersStillLayout([]), false);
});

test("a season of episodes lays out as stills", () => {
  const season = Array.from({ length: 22 }, () => ({ PrimaryImageAspectRatio: 1.333 }));
  assert.equal(prefersStillLayout(season), true);
});

test("a shelf of films stays posters", () => {
  const films = Array.from({ length: 20 }, () => ({ PrimaryImageAspectRatio: 0.667 }));
  assert.equal(prefersStillLayout(films), false);
});

test("one stray still does not flip a row of posters", () => {
  const row = [
    { PrimaryImageAspectRatio: 0.667 },
    { PrimaryImageAspectRatio: 0.667 },
    { PrimaryImageAspectRatio: 1.778 },
  ];
  assert.equal(prefersStillLayout(row), false);
});

test("an exact tie stays with posters — the shape that crops less when wrong", () => {
  const row = [{ PrimaryImageAspectRatio: 0.667 }, { PrimaryImageAspectRatio: 1.778 }];
  assert.equal(prefersStillLayout(row), false);
});

test("a majority of stills wins", () => {
  const row = [
    { PrimaryImageAspectRatio: 0.667 },
    { PrimaryImageAspectRatio: 1.778 },
    { PrimaryImageAspectRatio: 1.333 },
  ];
  assert.equal(prefersStillLayout(row), true);
});

test("items with no aspect ratio count against stills, so a metadata-less group stays posters", () => {
  const row = [{}, {}, { PrimaryImageAspectRatio: 1.778 }];
  assert.equal(prefersStillLayout(row), false);
});
