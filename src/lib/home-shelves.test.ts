import assert from "node:assert/strict";
import { test } from "node:test";

import {
  daySeed,
  franchiseHeading,
  isShelfKeyword,
  keywordHeading,
  MIN_SHELF_SIZE,
  pickShelves,
  type ShelfCandidate,
} from "./home-shelves.ts";

const paths = (n: number) => Array.from({ length: n }, (_, i) => `/media/f${i}.mkv`);

const shelf = (kind: ShelfCandidate["kind"], key: string, size: number): ShelfCandidate => ({
  kind,
  key,
  title: key,
  paths: paths(size),
});

test("one shelf of each kind, in page order", () => {
  const picked = pickShelves(
    [shelf("keyword", "found footage", 8), shelf("crew", "p1", 6), shelf("franchise", "c1", 3)],
    100,
  );
  assert.deepEqual(
    picked.map((s) => s.kind),
    ["franchise", "crew", "keyword"],
  );
});

test("a shelf below its kind's minimum is never shown", () => {
  const picked = pickShelves(
    [
      shelf("crew", "p1", MIN_SHELF_SIZE.crew - 1),
      shelf("keyword", "k1", MIN_SHELF_SIZE.keyword - 1),
      shelf("franchise", "c1", MIN_SHELF_SIZE.franchise - 1),
    ],
    7,
  );
  assert.deepEqual(picked, []);
});

test("the same day always gives the same shelves, whatever order they arrive in", () => {
  const set = [shelf("crew", "a", 5), shelf("crew", "b", 5), shelf("crew", "c", 5), shelf("crew", "d", 5)];
  const once = pickShelves(set, 20_000).map((s) => s.key);
  const reversed = pickShelves(set.slice().reverse(), 20_000).map((s) => s.key);
  assert.deepEqual(once, reversed);
});

test("the shelves rotate from day to day", () => {
  const set = ["a", "b", "c", "d", "e"].map((k) => shelf("keyword", k, 6));
  const seen = new Set<string>();
  for (let day = 0; day < 10; day += 1) seen.add(pickShelves(set, 20_000 + day)[0]!.key);
  // Over ten days a five-shelf pool should not sit on one choice.
  assert.ok(seen.size >= 3, `only saw ${[...seen].join(", ")}`);
});

test("a kind with nothing big enough is simply left out", () => {
  const picked = pickShelves([shelf("crew", "p", 9)], 3);
  assert.deepEqual(
    picked.map((s) => s.kind),
    ["crew"],
  );
});

test("the day seed ticks over at midnight UTC and not before", () => {
  const midnight = Date.UTC(2026, 8, 10);
  assert.equal(daySeed(midnight - 1) + 1, daySeed(midnight));
  assert.equal(daySeed(midnight), daySeed(midnight + 86_399_999));
});

/** The live top-forty was led by exactly these, which is why the filter exists. */
test("production metadata and mood tags are not shelves", () => {
  for (const k of ["based on novel or book", "duringcreditsstinger", "woman director", "sequel", "bewildered", "intense"]) {
    assert.equal(isShelfKeyword(k), false, k);
  }
});

test("some subjects are not a heading to meet on a home page", () => {
  for (const k of ["suicide", "nazi", "rape"]) assert.equal(isShelfKeyword(k), false, k);
});

test("real subjects are shelves", () => {
  for (const k of ["new york city", "found footage", "italian neo realism", "world war ii", "zombie"]) {
    assert.equal(isShelfKeyword(k), true, k);
  }
});

test("headings are capitalised the way a person would write them", () => {
  assert.equal(keywordHeading("new york city"), "New York City");
  assert.equal(keywordHeading("world war ii"), "World War II");
  assert.equal(keywordHeading("neo-noir"), "Neo-Noir");
  assert.equal(keywordHeading("rome, italy"), "Rome, Italy");
});

test("a TMDB collection loses its 'Collection' suffix", () => {
  assert.equal(franchiseHeading("Resident Evil Collection"), "Resident Evil");
  assert.equal(franchiseHeading("[REC] Collection"), "[REC]");
  assert.equal(franchiseHeading("Collection of Stories"), "Collection of Stories");
});
