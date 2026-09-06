import assert from "node:assert/strict";
import { test } from "node:test";

import { isTvUserAgent, resolveTvMode, tvModeFromCookie } from "./tv/constants.ts";

/**
 * Lives here rather than next to the source it covers because every other test
 * in this project is flat in src/lib, and the documented run command globs
 * `src/lib/*.test.ts` — a test one directory deeper would never be run, which
 * is worse than not writing it.
 */

const androidBase =
  "Mozilla/5.0 (Linux; Android 9; %MODEL% Build/PS7233; wv) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Safari/537.36";
const withModel = (model: string) => androidBase.replace("%MODEL%", model);

test("recognises the Fire TV model codes people actually own", () => {
  // The old pattern was \baft[bmnst]\b, so every one of these returned false
  // and a Fire TV silently got the phone layout.
  for (const model of [
    "AFTKA", // Stick 4K Max
    "AFTMM", // Stick 4K
    "AFTSSS", // Stick Lite
    "AFTSS", // Stick, 3rd gen
    "AFTKMST12", // Cube, 2nd gen
    "AFTBAMR311", // TV Omni
    "AFTGAZL", // Cube, 3rd gen
    "AFTEU011", // Stick Basic Edition
  ]) {
    assert.equal(isTvUserAgent(withModel(model)), true, `${model} should be a TV`);
  }
});

test("still recognises the short codes the old pattern covered", () => {
  for (const model of ["AFTB", "AFTM", "AFTN", "AFTS", "AFTT"]) {
    assert.equal(isTvUserAgent(withModel(model)), true, `${model} should be a TV`);
  }
});

test("does not mistake the word 'after' for a Fire TV", () => {
  // This is the whole reason the Fire TV pattern is case-sensitive. If anyone
  // adds /i to it, these fail — which is the point of writing them down.
  for (const prose of [
    "Mozilla/5.0 (compatible; SomeBot/1.0; crawls shortly after midnight)",
    "Mozilla/5.0 aftermath",
    "Mozilla/5.0 afternoon",
    "Mozilla/5.0 afterwards",
    "Mozilla/5.0 After Effects",
  ]) {
    assert.equal(isTvUserAgent(prose), false, `should not be a TV: ${prose}`);
  }
});

test("does not match AFT inside a longer word", () => {
  // The leading \b earns its keep here.
  assert.equal(isTvUserAgent("Mozilla/5.0 DRAFTKINGS/3.2"), false);
  assert.equal(isTvUserAgent("Mozilla/5.0 (CRAFTBOT)"), false);
});

test("ordinary phones and desktops are not televisions", () => {
  const phone =
    "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/UQ1A; wv) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Safari/537.36";
  const desktop =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/120.0.0.0 Safari/537.36";
  assert.equal(isTvUserAgent(phone), false);
  assert.equal(isTvUserAgent(desktop), false);
  assert.equal(isTvUserAgent(null), false);
  assert.equal(isTvUserAgent(""), false);
});

test("the other TV platforms still match", () => {
  assert.equal(isTvUserAgent("Mozilla/5.0 (SMART-TV; Linux; Tizen 6.0)"), true);
  assert.equal(isTvUserAgent("Mozilla/5.0 (Web0S; Linux/SmartTV)"), true);
  assert.equal(isTvUserAgent("Mozilla/5.0 (X11; Linux) CrKey/1.56"), true);
  assert.equal(isTvUserAgent("Mozilla/5.0 (Linux; Android 12) AndroidTV"), true);
  assert.equal(isTvUserAgent("Roku/DVP-9.10"), true);
});

test("the shell's appended token is what puts a TV box into TV mode", () => {
  // Android System WebView on a TV box reports an ordinary Android agent, so
  // apps/mobile appends " AndroidTV" itself. Both halves are asserted here so
  // that narrowing these patterns cannot quietly break the TV app.
  const tvWebView =
    "Mozilla/5.0 (Linux; Android 12; Chromecast Build/STTE.240206.002; wv) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Safari/537.36";
  assert.equal(isTvUserAgent(tvWebView), false, "bare TV WebView looks like a phone");
  assert.equal(isTvUserAgent(`${tvWebView} AndroidTV`), true, "with the shell's token");
});

test("the cookie overrides whatever the agent says, in both directions", () => {
  const tv = withModel("AFTKA");
  const phone = "Mozilla/5.0 (Linux; Android 14; Pixel 8)";

  assert.equal(tvModeFromCookie("1"), true);
  assert.equal(tvModeFromCookie("0"), false);
  assert.equal(tvModeFromCookie(undefined), null);

  // A Fire TV told to stop being a TV stays not-a-TV...
  assert.equal(resolveTvMode({ cookieValue: "0", userAgent: tv }), false);
  // ...and a phone told to be one is honoured, which is how you test ten-foot
  // mode without owning a television.
  assert.equal(resolveTvMode({ cookieValue: "1", userAgent: phone }), true);
  // With no cookie it falls back to the agent.
  assert.equal(resolveTvMode({ cookieValue: undefined, userAgent: tv }), true);
  assert.equal(resolveTvMode({ cookieValue: undefined, userAgent: phone }), false);
});
