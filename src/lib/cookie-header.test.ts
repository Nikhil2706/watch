import assert from "node:assert/strict";
import { test } from "node:test";

import { readCookie } from "./cookie-header.ts";

test("finds the cookie wherever it sits in the header", () => {
  assert.equal(readCookie("jfg_screening=abc", "jfg_screening"), "abc");
  // The case that broke screenings: another cookie first, with a space.
  assert.equal(readCookie("watch_tv=0; jfg_screening=abc", "jfg_screening"), "abc");
  assert.equal(readCookie("a=1;jfg_screening=abc;b=2", "jfg_screening"), "abc");
});

test("matches the whole name, not a suffix", () => {
  assert.equal(readCookie("xjfg_screening=nope; jfg_screening=yes", "jfg_screening"), "yes");
  assert.equal(readCookie("xjfg_screening=nope", "jfg_screening"), null);
});

test("decodes, and survives a malformed value", () => {
  assert.equal(readCookie("s=a%20b", "s"), "a b");
  assert.equal(readCookie("s=%E0%A4%A", "s"), "%E0%A4%A");
  assert.equal(readCookie(null, "s"), null);
  assert.equal(readCookie("", "s"), null);
});
