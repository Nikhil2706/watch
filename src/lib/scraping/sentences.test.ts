import assert from "node:assert/strict";
import { test } from "node:test";

import { hasDanglingQuote, splitSentences } from "./sentences.ts";

test("keeps a sentence whole across titles and initials", () => {
  assert.deepEqual(
    splitSentences(
      "Sympathy for Mr. Vengeance did not fare well commercially. It won several awards. " +
        "David S. Goyer signed on to write the script. Speaking about Black Panther, Michael B. Jordan praised it.",
    ),
    [
      "Sympathy for Mr. Vengeance did not fare well commercially.",
      "It won several awards.",
      "David S. Goyer signed on to write the script.",
      "Speaking about Black Panther, Michael B. Jordan praised it.",
    ],
  );
});

test("dates and 'vs.' do not end a sentence; 'the U.S.' still can", () => {
  assert.deepEqual(splitSentences("It opened on Dec. 5 in New York. Batman vs. Superman followed."), [
    "It opened on Dec. 5 in New York.",
    "Batman vs. Superman followed.",
  ]);
  // Films are "released in the U.S." at the end of a sentence far more often
  // than a sentence runs on after it, so this one stays a break.
  assert.deepEqual(splitSentences("It was released in the U.S. Critics liked it."), [
    "It was released in the U.S.",
    "Critics liked it.",
  ]);
});

test("still splits ordinary sentences, and words ending in a capital letter stay splittable", () => {
  assert.deepEqual(splitSentences("He left. She stayed! Why? Nobody knew."), ["He left.", "She stayed!", "Why?", "Nobody knew."]);
  assert.deepEqual(splitSentences("It was shot on VHS. Then it was restored."), ["It was shot on VHS.", "Then it was restored."]);
});

test("a fact holding half a quotation is caught; a whole one is not", () => {
  assert.equal(
    hasDanglingQuote('I realized I needed to raise the emotional stakes." Nolan worked on the script for nine to ten years.'),
    true,
  );
  assert.equal(hasDanglingQuote("He called it \u201Cthe hardest shoot of my life."), true);
  assert.equal(hasDanglingQuote("of my life,\u201D he said later."), true);
  assert.equal(hasDanglingQuote('Nolan called it "a heist film" in interviews.'), false);
  assert.equal(hasDanglingQuote("It\u2019s the director\u2019s third film, and Nolan's longest."), false);
});
