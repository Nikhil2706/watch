/**
 * Tests for collapsing a watched list to one entry per show.
 *
 * Run:
 *   node --test --experimental-strip-types \
 *        --disable-warning=ExperimentalWarning src/lib/latest-per-show.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { latestPerShow } from "./latest-per-show.ts";

type Watched = { id: string; show?: string };
const showOf = (w: Watched) => w.show;
const ids = (list: Watched[]) => list.map((w) => w.id);

test("keeps each show's newest episode, in order", () => {
  const recent: Watched[] = [
    { id: "nfy-s1e6", show: "nfy" },
    { id: "buffy-s1e5", show: "buffy" },
    { id: "buffy-s1e4", show: "buffy" },
    { id: "nfy-s1e4", show: "nfy" },
    { id: "buffy-s1e3", show: "buffy" },
  ];
  assert.deepEqual(ids(latestPerShow(recent, showOf)), ["nfy-s1e6", "buffy-s1e5"]);
});

test("films are never collapsed", () => {
  const recent: Watched[] = [{ id: "film-a" }, { id: "buffy-s1e5", show: "buffy" }, { id: "film-b" }, { id: "buffy-s1e4", show: "buffy" }];
  assert.deepEqual(ids(latestPerShow(recent, showOf)), ["film-a", "buffy-s1e5", "film-b"]);
});

test("the limit counts what is kept, not what is read", () => {
  const recent: Watched[] = [
    { id: "b5", show: "buffy" },
    { id: "b4", show: "buffy" },
    { id: "b3", show: "buffy" },
    { id: "film" },
    { id: "n6", show: "nfy" },
  ];
  assert.deepEqual(ids(latestPerShow(recent, showOf, 2)), ["b5", "film"]);
});

test("an empty list stays empty", () => {
  assert.deepEqual(latestPerShow([], showOf), []);
});
