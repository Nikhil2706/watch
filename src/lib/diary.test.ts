import assert from "node:assert/strict";
import { test } from "node:test";

import { diaryEntries } from "./diary.ts";

test("newest first; a second finish of the same thing is a rewatch", () => {
  const entries = diaryEntries(
    [
      { itemId: "halloween", imdbId: "tt0077651", watchedAt: 300 },
      { itemId: "arrival", imdbId: "tt2543164", watchedAt: 200 },
      { itemId: "halloween", imdbId: "tt0077651", watchedAt: 100 },
    ],
    new Map(),
    new Map(),
  );
  assert.deepEqual(
    entries.map((e) => [e.itemId, e.watchedAt, e.rewatch]),
    [
      ["halloween", 300, true],
      ["arrival", 200, false],
      ["halloween", 100, false],
    ],
  );
});

test("their stars and review ride along with each entry", () => {
  const [entry] = diaryEntries(
    [{ itemId: "arrival", imdbId: "tt2543164", watchedAt: 1 }],
    new Map([["tt2543164", 9]]),
    new Map([["tt2543164", "Made me call my mother."]]),
  );
  assert.equal(entry!.score, 9);
  assert.equal(entry!.review, "Made me call my mother.");
});

test("a show's episode takes the show's rating, through imdbOf", () => {
  const [entry] = diaryEntries(
    [{ itemId: "ep1", imdbId: "tt-episode", watchedAt: 1 }],
    new Map([["tt-series", 8]]),
    new Map(),
    () => "tt-series",
  );
  assert.equal(entry!.score, 8);
});

test("nothing known about it: no stars, no review", () => {
  const [entry] = diaryEntries([{ itemId: "x", imdbId: null, watchedAt: 1 }], new Map([["tt1", 5]]), new Map());
  assert.deepEqual([entry!.score, entry!.review], [null, null]);
});
