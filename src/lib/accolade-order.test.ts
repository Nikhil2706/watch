import assert from "node:assert/strict";
import { test } from "node:test";

import {
  insertAt,
  isDense,
  moveByOne,
  moveTo,
  removeFrom,
  slotChanges,
} from "./accolade-order.ts";

/** A list of five, the shape a "best of the year" list churns through. */
const list = ["a", "b", "c", "d", "e"];

test("a new film enters in the middle and pushes the rest down", () => {
  assert.deepEqual(insertAt(list, "new", 2), ["a", "b", "new", "c", "d", "e"]);
});

test("a new film can enter at the top", () => {
  assert.deepEqual(insertAt(list, "new", 0), ["new", "a", "b", "c", "d", "e"]);
});

test("a position past the end appends rather than throwing", () => {
  assert.deepEqual(insertAt(list, "new", 99), ["a", "b", "c", "d", "e", "new"]);
});

test("a negative position clamps to the top", () => {
  assert.deepEqual(insertAt(list, "new", -3), ["new", "a", "b", "c", "d", "e"]);
});

test("inserting something already in the list moves it rather than duplicating", () => {
  assert.deepEqual(insertAt(list, "e", 0), ["e", "a", "b", "c", "d"]);
  assert.equal(new Set(insertAt(list, "e", 0)).size, 5);
});

test("removing a film closes the gap", () => {
  assert.deepEqual(removeFrom(list, "c"), ["a", "b", "d", "e"]);
});

test("removing something absent leaves the list alone", () => {
  assert.deepEqual(removeFrom(list, "zzz"), list);
});

test("a film can move from the bottom to the top in one step", () => {
  assert.deepEqual(moveTo(list, "e", 0), ["e", "a", "b", "c", "d"]);
});

test("a film can move from the top to the bottom in one step", () => {
  assert.deepEqual(moveTo(list, "a", 4), ["b", "c", "d", "e", "a"]);
});

test("moving to its own position changes nothing", () => {
  assert.deepEqual(moveTo(list, "c", 2), list);
});

test("moving something absent is a no-op, not an insert", () => {
  assert.deepEqual(moveTo(list, "zzz", 0), list);
});

test("a move never changes the length or loses an entry", () => {
  for (let from = 0; from < list.length; from += 1) {
    for (let to = 0; to < list.length; to += 1) {
      const out = moveTo(list, list[from]!, to);
      assert.equal(out.length, list.length);
      assert.deepEqual([...out].sort(), [...list].sort());
    }
  }
});

test("the up and down arrows still swap neighbours", () => {
  assert.deepEqual(moveByOne(list, "c", "up"), ["a", "c", "b", "d", "e"]);
  assert.deepEqual(moveByOne(list, "c", "down"), ["a", "b", "d", "c", "e"]);
});

test("nudging past either end is a no-op", () => {
  assert.deepEqual(moveByOne(list, "a", "up"), list);
  assert.deepEqual(moveByOne(list, "e", "down"), list);
});

test("slotChanges returns only what actually moved", () => {
  const current = new Map([["a", 0], ["b", 1], ["c", 2], ["d", 3], ["e", 4]]);
  const reordered = moveByOne(list, "d", "down"); // swaps d and e
  assert.deepEqual(slotChanges(reordered, current), [
    { id: "e", slot: 3 },
    { id: "d", slot: 4 },
  ]);
});

test("slotChanges is empty when nothing moved", () => {
  const current = new Map([["a", 0], ["b", 1], ["c", 2], ["d", 3], ["e", 4]]);
  assert.deepEqual(slotChanges(list, current), []);
});

test("slotChanges repairs a list that already has a hole", () => {
  // The state the old delete left behind: slot 2 missing.
  const current = new Map([["a", 0], ["b", 1], ["d", 3], ["e", 4]]);
  const ordered = ["a", "b", "d", "e"];
  assert.deepEqual(slotChanges(ordered, current), [
    { id: "d", slot: 2 },
    { id: "e", slot: 3 },
  ]);
});

test("removing then inserting cannot collide — the bug this replaces", () => {
  // Old behaviour: delete "c" leaves slots 0,1,3,4; the console then computes
  // the next slot from the row count (4) and upsert overwrites "e" at slot 4.
  let ids = removeFrom(list, "c");
  ids = insertAt(ids, "new", ids.length);
  assert.deepEqual(ids, ["a", "b", "d", "e", "new"]);
  assert.ok(ids.includes("e"), "the last entry must survive");
  assert.equal(new Set(ids).size, ids.length);
});

test("isDense recognises a healthy list and a holed one", () => {
  assert.equal(isDense([0, 1, 2, 3]), true);
  assert.equal(isDense([]), true);
  assert.equal(isDense([0, 1, 3]), false);
  assert.equal(isDense([1, 2, 3]), false, "must be zero-based");
});

test("a full year of churn keeps the list dense and intact", () => {
  let ids = ["jan", "feb", "mar"];
  ids = insertAt(ids, "apr", 1);
  ids = removeFrom(ids, "feb");
  ids = insertAt(ids, "may", 0);
  ids = moveTo(ids, "mar", 0);
  ids = removeFrom(ids, "jan");
  assert.deepEqual(ids, ["mar", "may", "apr"]);
  assert.equal(new Set(ids).size, ids.length);
  const current = new Map(ids.map((id, i) => [id, i]));
  assert.deepEqual(slotChanges(ids, current), []);
});
