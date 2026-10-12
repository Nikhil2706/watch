import assert from "node:assert/strict";
import { test } from "node:test";

import { looseKey, nearTitle } from "./title-match-rules.ts";

test("a trailing 'film' or 'movie' is the list's word, not the title's", () => {
  assert.equal(looseKey("ready player one film"), "ready player one");
  assert.equal(looseKey("one battle after another movie"), "one battle after another");
  assert.equal(looseKey("scary movie"), "scary movie");
  assert.equal(looseKey("film"), "film");
  assert.equal(looseKey("the film of my life"), "the film of my life");
});

test("a plural or a letter in a short word is the same title", () => {
  assert.equal(nearTitle("the nice guy", "the nice guys"), true);
  assert.equal(nearTitle("ford vs ferrari", "ford v ferrari"), true);
});

test("a title with a word taken out, added or changed is a different film", () => {
  // Every pair here was a real wrong link on the live site.
  for (const [a, b] of [
    ["dancer in the dark", "in the dark"],
    ["alone in the dark", "in the dark"],
    ["all about eve", "all about christmas eve"],
    ["do the right thing", "the right thing"],
    ["from here to eternity", "from here to paternity"],
    ["the silence of the lambs", "the look of silence"],
    ["shaun of the dead", "land of the dead"],
    ["hell or high water", "hell and high water"],
    ["three nights of a dreamer", "four nights of a dreamer"],
    ["agnes and his brothers", "rocco and his brothers"],
    ["the killer inside me", "the killer in me"],
    ["news of the world", "the weight of the world"],
    ["norte the end of history", "the beginning of the end"],
    ["the fast and the furious", "the fast and the furious tokyo drift"],
  ] as const) {
    assert.equal(nearTitle(a, b), false, `${a} / ${b}`);
  }
});

test("one word is never enough to go on", () => {
  assert.equal(nearTitle("cat", "cats"), false);
  assert.equal(nearTitle("the cat", "the car"), false);
});
