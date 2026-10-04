import assert from "node:assert/strict";
import { test } from "node:test";

import { CAPTION_MIN_PX, captionFontPx, pictureWidth } from "./caption-size.ts";

const HD = { width: 1920, height: 1080 };
const SCOPE = { width: 1920, height: 804 };
const ACADEMY = { width: 1440, height: 1080 };

test("a TV keeps the size it had", () => {
  assert.equal(captionFontPx({ width: 1920, height: 1080 }, HD), 48);
});

test("the same share of the picture on a desktop window and in fullscreen", () => {
  assert.equal(captionFontPx({ width: 1120, height: 630 }, HD), 28);
  assert.equal(captionFontPx({ width: 1536, height: 864 }, HD), 38);
});

test("a wide film gets the same text as a 16:9 one on the same screen", () => {
  assert.equal(captionFontPx({ width: 1920, height: 1080 }, SCOPE), 48);
});

test("a pillarboxed film is measured by its picture, not the screen", () => {
  assert.equal(pictureWidth({ width: 1920, height: 1080 }, ACADEMY), 1440);
  assert.equal(captionFontPx({ width: 1920, height: 1080 }, ACADEMY), 36);
});

test("a phone held upright stays readable", () => {
  assert.equal(captionFontPx({ width: 390, height: 219 }, HD), CAPTION_MIN_PX);
});

test("a phone on its side scales with the picture", () => {
  assert.equal(captionFontPx({ width: 844, height: 390 }, HD), 17);
});

test("before the video's size is known the box is used", () => {
  assert.equal(pictureWidth({ width: 800, height: 450 }, null), 800);
  assert.equal(pictureWidth({ width: 800, height: 450 }, { width: 0, height: 0 }), 800);
});
