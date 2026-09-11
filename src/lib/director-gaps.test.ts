import assert from "node:assert/strict";
import { test } from "node:test";

import { directorGaps, type GapFilm } from "./director-gaps.ts";

const film = (tmdbId: number, year: number | null): GapFilm => ({
  tmdbId,
  title: `Film ${tmdbId}`,
  year,
  posterUrl: null,
});

test("owned films count toward the total and are left off the missing row", () => {
  const gaps = directorGaps([film(1, 1945), film(2, 1946), film(3, 1948)], new Set([2]), 2026);
  assert.equal(gaps.owned, 1);
  assert.equal(gaps.total, 3);
  assert.deepEqual(
    gaps.missing.map((f) => f.tmdbId),
    [1, 3],
  );
});

test("a film that is not out yet counts toward neither number", () => {
  const gaps = directorGaps([film(1, 2020), film(2, 2031)], new Set(), 2026);
  assert.equal(gaps.total, 1);
  assert.deepEqual(
    gaps.missing.map((f) => f.tmdbId),
    [1],
  );
});

test("the row is capped, but the counts still describe everything", () => {
  const many = Array.from({ length: 40 }, (_, i) => film(i + 1, 1950 + i));
  const gaps = directorGaps(many, new Set([1]), 2026, 24);
  assert.equal(gaps.missing.length, 24);
  assert.equal(gaps.total, 40);
  assert.equal(gaps.owned, 1);
});

test("owning everything leaves nothing missing", () => {
  const gaps = directorGaps([film(1, 1960), film(2, 1961)], new Set([1, 2]), 2026);
  assert.deepEqual(gaps, { owned: 2, total: 2, missing: [] });
});

test("someone TMDB credits with no direction at all yields zeros, not a crash", () => {
  assert.deepEqual(directorGaps([], new Set([1]), 2026), { owned: 0, total: 0, missing: [] });
});
