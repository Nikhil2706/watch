import assert from "node:assert/strict";
import { test } from "node:test";

import { NEXT_UP_MAX_AGE_DAYS, continueWatchingOrder, nextUpEpisodes, type EpisodeState } from "./next-up.ts";

const NOW = Date.UTC(2026, 9, 22, 18);
const DAY = 86_400_000;

function ep(n: number, played: boolean, lastPlayedMs: number | null = null): EpisodeState {
  return { id: `e${n}`, sortKey: 1000 + n, path: `/media/Nathan For You/S01E0${n}.mkv`, played, lastPlayedMs };
}

test("finishing an episode offers the next one (Nathan For You)", () => {
  const shows = new Map([["nfy", [ep(1, true, NOW - DAY), ep(2, false), ep(3, false)]]]);
  assert.deepEqual(nextUpEpisodes(shows, new Set(), NOW), [{ id: "e2", groupId: "nfy", at: NOW - DAY }]);
});

test("episode order is the show's, whatever order they arrive in", () => {
  const shows = new Map([["nfy", [ep(3, false), ep(1, true, NOW - DAY), ep(2, false)]]]);
  assert.equal(nextUpEpisodes(shows, new Set(), NOW)[0]!.id, "e2");
});

test("goes from the most recently watched, skipping ones already seen", () => {
  // Watched 1 long ago, then 3 yesterday; 4 is seen already (marked), so 5 is next.
  const shows = new Map([["s", [ep(1, true, NOW - 30 * DAY), ep(2, false), ep(3, true, NOW - DAY), ep(4, true), ep(5, false)]]]);
  assert.equal(nextUpEpisodes(shows, new Set(), NOW)[0]!.id, "e5");
});

test("nothing after the last episode", () => {
  assert.deepEqual(nextUpEpisodes(new Map([["s", [ep(1, true, NOW - DAY), ep(2, true, NOW)]]]), new Set(), NOW), []);
});

test("a show part-way through an episode is left to that episode's card", () => {
  const shows = new Map([["s", [ep(1, true, NOW - DAY), ep(2, false)]]]);
  assert.deepEqual(nextUpEpisodes(shows, new Set(["s"]), NOW), []);
  // And the most recent one stopped part-way (played false, but has a date) offers nothing either.
  assert.deepEqual(nextUpEpisodes(new Map([["s", [ep(1, true, NOW - 2 * DAY), ep(2, false, NOW - DAY), ep(3, false)]]]), new Set(), NOW), []);
});

test("a show never started, or left too long ago, is not offered", () => {
  assert.deepEqual(nextUpEpisodes(new Map([["s", [ep(1, false), ep(2, false)]]]), new Set(), NOW), []);
  const old = NOW - (NEXT_UP_MAX_AGE_DAYS + 1) * DAY;
  assert.deepEqual(nextUpEpisodes(new Map([["s", [ep(1, true, old), ep(2, false)]]]), new Set(), NOW), []);
});

test("Continue watching mixes both, most recent first, up to the limit", () => {
  const order = continueWatchingOrder(
    [
      { id: "film", at: NOW - 2 * DAY },
      { id: "other", at: NOW - 5 * DAY },
    ],
    [{ id: "e2", groupId: "nfy", at: NOW - DAY }],
    new Map(),
    2,
  );
  assert.deepEqual(order, [
    { id: "e2", nextUp: true },
    { id: "film", nextUp: false },
  ]);
});

test("a removed card stays away until there is something newer", () => {
  const resume = [{ id: "film", at: NOW - 2 * DAY }];
  const next = [{ id: "e2", groupId: "nfy", at: NOW - DAY }];
  const removed = new Map([
    ["film", NOW - DAY],
    ["e2", NOW - DAY / 2],
  ]);
  assert.deepEqual(continueWatchingOrder(resume, next, removed, 12), []);
  // Played again after it was removed: back.
  assert.deepEqual(continueWatchingOrder([{ id: "film", at: NOW }], next, removed, 12), [{ id: "film", nextUp: false }]);
});
