import assert from "node:assert/strict";
import { test } from "node:test";

import { bestMatches, matchScore } from "./admin-search-match.ts";

const HUSH = "buffy the vampire slayer s04e10 hush";

test("a title the query opens ranks above one that only contains it", () => {
  assert.equal(matchScore("stoker", "stoker"), 3);
  assert.equal(matchScore("bram stoker s dracula", "stoker"), 2);
});

test("words are found anywhere, in any order", () => {
  assert.equal(matchScore(HUSH, "buffy s04"), 1);
  assert.equal(matchScore(HUSH, "buffy hush"), 1);
  assert.equal(matchScore(HUSH, "hush buffy"), 1);
  assert.equal(matchScore("in the dark", "in dark"), 1);
});

test("every word has to be there", () => {
  assert.equal(matchScore(HUSH, "buffy s05"), 0);
  assert.equal(matchScore(HUSH, "angel hush"), 0);
});

test("an empty query matches nothing", () => {
  assert.equal(matchScore(HUSH, ""), 0);
});

test("the closest matches are kept, in library order within a score", () => {
  const hits = [
    { name: "a", score: 1 as const },
    { name: "b", score: 3 as const },
    { name: "c", score: 1 as const },
    { name: "d", score: 2 as const },
  ];
  assert.deepEqual(
    bestMatches(hits, 3).map((h) => h.name),
    ["b", "d", "a"],
  );
});
