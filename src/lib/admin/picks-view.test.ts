import { test } from "node:test";
import assert from "node:assert/strict";

import { countsLine, droppedBefore, fullOrder, homeNote, itemBody, moved, pickChips, publishQuestion, sourceBits, splitItems, underOf, usePassage, type Pick, type PickItem } from "./picks-view.ts";

const NOW = Date.UTC(2026, 9, 15);
const pick = (over: Partial<Pick> = {}): Pick => ({
  id: "p",
  title: "Itch",
  subtitle: null,
  status: "draft",
  audience: "everyone",
  ranked: false,
  labelled: false,
  pinned: false,
  published_at: null,
  recipient_count: 0,
  item_count: 10,
  matched_count: 8,
  ...over,
});

test("chips and Home note", () => {
  const live = pick({ status: "live", published_at: NOW - 2 * 864e5, audience: "people", recipient_count: 1 });
  const texts = pickChips(live, NOW).map((c) => c.text);
  assert.equal(texts[0], "Live");
  assert.equal(texts[1], "1 person");
  assert.match(texts[2]!, /^On Home until/);
  assert.equal(texts[3], "8 of 10 titles");
  assert.match(homeNote(live, NOW), /^On Home until/);
  assert.match(homeNote(pick({ status: "live", published_at: NOW - 9 * 864e5 }), NOW), /^No longer on Home/);
  assert.equal(homeNote(pick({ pinned: true }), NOW), "Stays on Home until you untick this.");
  assert.equal(homeNote(pick(), NOW), "On Home for 7 days from publishing.");
});

test("under each poster", () => {
  assert.equal(underOf(pick({ ranked: true })), "number");
  assert.equal(underOf(pick({ labelled: 1 })), "word");
  assert.equal(underOf(pick()), "nothing");
});

test("publish question", () => {
  assert.equal(publishQuestion(pick(), 0), "Publish “Itch” to everyone?");
  assert.equal(publishQuestion(pick({ audience: "people" }), 2), "Publish “Itch” to 2 people, who will be notified?");
});

const item = (id: string, inLibrary = true): PickItem => ({
  id,
  displayTitle: id,
  displayYear: null,
  kind: "film",
  inLibrary,
  posterUrl: null,
  imdb_id: null,
  rank: null,
  label: null,
  writeup: null,
  writeup_source_label: null,
  writeup_source_url: null,
});

test("present and missing, and the counts line", () => {
  const { present, missing } = splitItems([item("a"), item("b", false), item("c")]);
  assert.deepEqual(present.map((p) => [p.it.id, p.index]), [["a", 0], ["c", 2]]);
  assert.deepEqual(missing.map((p) => p.it.id), ["b"]);
  assert.equal(countsLine(2, 1), "2 titles on the site · 1 not in the library");
});

test("reordering: arrows, drop, and missing titles kept after", () => {
  assert.deepEqual(moved(["a", "b", "c"], "b", "up"), ["b", "a", "c"]);
  assert.equal(moved(["a", "b"], "a", "up"), null);
  assert.deepEqual(droppedBefore(["a", "b", "c"], "c", "a"), ["c", "a", "b"]);
  assert.deepEqual(fullOrder(["c", "a"], [item("a"), item("b", false), item("c")]), ["c", "a", "b"]);
});

test("item body: clearing the credit clears its link; rank and word", () => {
  assert.deepEqual(itemBody({ writeup: "x", credit: " ", creditUrl: "https://a" }), { writeup: "x", writeup_source_label: null, writeup_source_url: null });
  assert.deepEqual(itemBody({ writeup: "x", credit: "Ringer", creditUrl: "https://a", rank: "", word: " Best " }), {
    writeup: "x",
    writeup_source_label: "Ringer",
    writeup_source_url: "https://a",
    rank: null,
    label: "Best",
  });
});

test("passages and source lines", () => {
  assert.equal(usePassage("Mine.  ", "Theirs.", "append"), "Mine.\n\nTheirs.");
  assert.equal(usePassage("Mine.", "Theirs.", "replace"), "Theirs.");
  assert.equal(sourceBits({ inLibrary: 4, entries: 10, ranked: true, withWriteups: 3 }), "4 of 10 in the library · ranked · 3 with a writeup");
});
