import assert from "node:assert/strict";
import { test } from "node:test";

import {
  HOME_WINDOW_MS,
  cleanLabel,
  labelFitLength,
  displayRank,
  orderForDisplay,
  showsOnHome,
  writeupParagraphs,
  writeupPlainText,
} from "./pick-rank.ts";

test("a hand-built pick numbers by position", () => {
  assert.equal(displayRank(null, 0), 1);
  assert.equal(displayRank(null, 4), 5);
});

test("a converted pick keeps the source's rank", () => {
  assert.equal(displayRank(19, 3), 19);
});

test("ranked picks run 1 first whatever order the rows were stored in", () => {
  const items = [
    { id: "a", rank: 10, position: 0 },
    { id: "b", rank: 2, position: 1 },
    { id: "c", rank: 7, position: 2 },
  ];
  assert.deepEqual(
    orderForDisplay(items, true).map((i) => i.id),
    ["b", "c", "a"],
  );
});

test("unranked picks keep the curator's order", () => {
  const items = [
    { id: "a", rank: 10, position: 2 },
    { id: "b", rank: 2, position: 0 },
    { id: "c", rank: null, position: 1 },
  ];
  assert.deepEqual(
    orderForDisplay(items, false).map((i) => i.id),
    ["b", "c", "a"],
  );
});

test("a writeup splits on blank lines and joins soft-wrapped ones", () => {
  assert.deepEqual(writeupParagraphs("One line\nstill one.\n\nTwo.\n\n\n"), ["One line still one.", "Two."]);
  assert.deepEqual(writeupParagraphs(null), []);
});

test("the tile text drops formatting tags", () => {
  assert.equal(writeupPlainText("An <i>itch</i> in the brain.\n\nSecond."), "An itch in the brain. Second.");
});

test("Home shows a pick for a week, or for as long as it is pinned", () => {
  const now = 1_800_000_000_000;
  assert.equal(showsOnHome({ pinned: false, publishedAt: now - 1000 }, now), true);
  assert.equal(showsOnHome({ pinned: false, publishedAt: now - HOME_WINDOW_MS - 1 }, now), false);
  assert.equal(showsOnHome({ pinned: true, publishedAt: now - HOME_WINDOW_MS * 5 }, now), true);
  assert.equal(showsOnHome({ pinned: false, publishedAt: null }, now), false);
});

test("a typed word is kept on one line, and an empty one is no word", () => {
  assert.equal(cleanLabel("  De   Sica \n"), "De Sica");
  assert.equal(cleanLabel("   "), null);
  assert.equal(cleanLabel(null), null);
});

test("every word in a pick is sized for its longest, and never larger than five characters would be", () => {
  assert.equal(labelFitLength(["Bava", "Rossellini", null, "De Sica"]), 10);
  assert.equal(labelFitLength(["Ray", "Ozu"]), 5);
  assert.equal(labelFitLength([]), 5);
});
