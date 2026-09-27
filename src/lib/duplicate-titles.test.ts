import assert from "node:assert/strict";
import { test } from "node:test";

import { duplicateIds } from "./duplicate-titles.ts";

test("same title, different films (The Climb short and feature) are not copies", () => {
  const ids = duplicateIds([
    { id: "short", titleKey: "the climb", imdbId: "tt7942374" },
    { id: "feature", titleKey: "the climb", imdbId: "tt10064712" },
  ]);
  assert.equal(ids.size, 0);
});

test("same title and same film are copies", () => {
  const ids = duplicateIds([
    { id: "a", titleKey: "hell house llc", imdbId: "tt4267026" },
    { id: "b", titleKey: "hell house llc", imdbId: "tt4267026" },
  ]);
  assert.deepEqual([...ids].sort(), ["a", "b"]);
});

test("an unidentified file is a possible copy of either", () => {
  const ids = duplicateIds([
    { id: "a", titleKey: "the climb", imdbId: "tt7942374" },
    { id: "b", titleKey: "the climb", imdbId: "tt10064712" },
    { id: "c", titleKey: "the climb", imdbId: null },
  ]);
  assert.deepEqual([...ids].sort(), ["a", "b", "c"]);
});

test("different titles never collide", () => {
  assert.equal(duplicateIds([{ id: "a", titleKey: "x", imdbId: null }, { id: "b", titleKey: "y", imdbId: null }]).size, 0);
});
