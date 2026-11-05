import assert from "node:assert/strict";
import { test } from "node:test";

import { cardActions, readCardOptions, type CardOptions } from "./card-options.ts";

const base: CardOptions = {
  itemId: "abc",
  title: "Angel",
  infoHref: "/item/angel-abc",
  playHref: "/watch/angel-abc?t=900",
  resuming: true,
  favourite: false,
  rewatch: true,
  watched: false,
  removable: true,
};

test("the panel says what each row will do, from the card's own state", () => {
  assert.deepEqual(
    cardActions(base).map((a) => a.label),
    ["Resume", "More info", "Add to Favourites", "Remove from Rewatch", "Mark as watched", "Remove from Continue watching"],
  );
});

test("a card off Continue watching has no remove row, and plays from the start", () => {
  const labels = cardActions({ ...base, removable: false, resuming: false, watched: true }).map((a) => a.label);
  assert.equal(labels[0], "Play");
  assert.ok(labels.includes("Mark as not watched"));
  assert.ok(!labels.includes("Remove from Continue watching"));
});

test("a card's attribute is read back, and anything malformed is ignored", () => {
  assert.deepEqual(readCardOptions(JSON.stringify(base)), base);
  assert.equal(readCardOptions("{not json"), null);
  assert.equal(readCardOptions(JSON.stringify({ title: "no id" })), null);
  assert.equal(readCardOptions(null), null);
});
