import assert from "node:assert/strict";
import { test } from "node:test";

import { isPermittedForScreening } from "./screening-scope.ts";

/**
 * The design names this the one thing that must not be got wrong: a screening
 * identity borrows a Jellyfin account that can see the whole library, so this
 * allow-list is the only scoping there is. Every permitted shape is asserted
 * to pass for its own item and fail for a different one.
 */

const MINE = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const THEIRS = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const allow = (p: string) => isPermittedForScreening(p, [MINE]);

test("the playback plan is permitted for the screening's own item", () => {
  assert.equal(allow(`items/${MINE}/playbackinfo`), true);
});

test("direct play is permitted, with and without a container extension", () => {
  assert.equal(allow(`videos/${MINE}/stream`), true);
  assert.equal(allow(`videos/${MINE}/stream.mp4`), true);
  assert.equal(allow(`videos/${MINE}/stream.mkv`), true);
});

test("transcode playlists and segments are permitted", () => {
  assert.equal(allow(`videos/${MINE}/main.m3u8`), true);
  assert.equal(allow(`videos/${MINE}/master.m3u8`), true);
  assert.equal(allow(`videos/${MINE}/hls1/main/0.ts`), true);
  assert.equal(allow(`videos/${MINE}/hls1/main/241.mp4`), true);
});

test("subtitle tracks are permitted", () => {
  assert.equal(allow(`videos/${MINE}/abc123/subtitles/2/stream.vtt`), true);
  assert.equal(allow(`videos/${MINE}/abc123/subtitles/0/stream.srt`), true);
});

test("images for the landing card are permitted", () => {
  assert.equal(allow(`items/${MINE}/images/primary`), true);
  assert.equal(allow(`items/${MINE}/images/backdrop/0`), true);
});

test("playback reporting is permitted, since the transcode depends on it", () => {
  assert.equal(allow("sessions/playing"), true);
  assert.equal(allow("sessions/playing/progress"), true);
  assert.equal(allow("sessions/playing/stopped"), true);
});

/* ---- the half that actually matters ---- */

test("every item-scoped shape is refused for a DIFFERENT item", () => {
  for (const path of [
    `items/${THEIRS}/playbackinfo`,
    `videos/${THEIRS}/stream`,
    `videos/${THEIRS}/stream.mp4`,
    `videos/${THEIRS}/main.m3u8`,
    `videos/${THEIRS}/master.m3u8`,
    `videos/${THEIRS}/hls1/main/0.ts`,
    `videos/${THEIRS}/abc123/subtitles/2/stream.vtt`,
    `items/${THEIRS}/images/primary`,
    `items/${THEIRS}/images/backdrop/0`,
  ]) {
    assert.equal(allow(path), false, `should refuse ${path}`);
  }
});

test("browsing the library is refused", () => {
  for (const path of [
    "items",
    "items?recursive=true",
    "users",
    "users/public",
    `users/${MINE}/items`,
    "library/mediafolders",
    "system/info",
    "sessions",
    "genres",
    "persons",
    "search/hints",
  ]) {
    assert.equal(allow(path), false, `should refuse ${path}`);
  }
});

test("a download of the permitted item is still refused — screenings do not hand out files", () => {
  assert.equal(allow(`items/${MINE}/download`), false);
});

test("traversal is refused even though proxy checks it first", () => {
  assert.equal(allow(`items/${MINE}/../../system/info`), false);
  assert.equal(allow(`videos/${MINE}/../${THEIRS}/stream`), false);
});

test("a prefix of a permitted path does not pass", () => {
  assert.equal(allow(`items/${MINE}`), false);
  assert.equal(allow(`videos/${MINE}`), false);
  assert.equal(allow(`items/${MINE}/images`), false);
});

test("a permitted path with something appended does not pass", () => {
  assert.equal(allow(`items/${MINE}/playbackinfo/extra`), false);
  assert.equal(allow(`items/${MINE}/playbackinfoextra`), false);
});

test("an id that is not 32 hex characters can never scope a rule", () => {
  // The nightmare case: a malformed id interpolated into the regex turning
  // every scoped rule into a wildcard over the library.
  for (const bad of [".*", "[a-z]+", "aaaa", "", "../..", `${MINE}x`]) {
    assert.equal(
      isPermittedForScreening(`items/${THEIRS}/playbackinfo`, [bad]),
      false,
      `id ${JSON.stringify(bad)} must not widen the allow-list`,
    );
    assert.equal(isPermittedForScreening(`videos/${THEIRS}/stream`, [bad]), false);
  }
});

test("an empty allow-list permits only the unscoped reporting endpoints", () => {
  assert.equal(isPermittedForScreening(`items/${MINE}/playbackinfo`, []), false);
  assert.equal(isPermittedForScreening("sessions/playing/progress", []), true);
});

test("a double bill permits both of its items and nothing else", () => {
  const both = [MINE, THEIRS];
  assert.equal(isPermittedForScreening(`videos/${MINE}/stream`, both), true);
  assert.equal(isPermittedForScreening(`videos/${THEIRS}/stream`, both), true);
  assert.equal(
    isPermittedForScreening("videos/cccccccccccccccccccccccccccccccc/stream", both),
    false,
  );
});

test("item ids are matched case-insensitively, since the proxy lowercases the path", () => {
  assert.equal(isPermittedForScreening(`videos/${MINE}/stream`, [MINE.toUpperCase()]), true);
});
