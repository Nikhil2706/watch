import assert from "node:assert/strict";
import { test } from "node:test";

import { startOverHref, watchHref } from "./slugs.ts";

test("watchHref leaves ?t= off for no position, which the watch page reads as resume", () => {
  assert.equal(watchHref("abc", "Angel", 1999), "/watch/angel-1999-abc");
  assert.equal(watchHref("abc", "Angel", 1999, 0), "/watch/angel-1999-abc");
  assert.equal(watchHref("abc", "Angel", 1999, 900), "/watch/angel-1999-abc?t=900");
});

test("startOverHref always says ?t=0, so Start over starts over", () => {
  assert.equal(startOverHref("abc", "Angel", 1999), "/watch/angel-1999-abc?t=0");
  assert.equal(startOverHref("abc"), "/watch/abc?t=0");
});
