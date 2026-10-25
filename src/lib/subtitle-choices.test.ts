import assert from "node:assert/strict";
import { test } from "node:test";

import { choiceTags, chosenSubtitlePath, rankChoices, releaseGroup, releaseMatch } from "./subtitle-choices.ts";
import type { SubtitleCandidate } from "./subtitle-match.ts";

function c(fileId: number, over: Partial<SubtitleCandidate> = {}): SubtitleCandidate {
  return {
    fileId,
    fileName: null,
    release: `Some.Other.Release.${fileId}`,
    uploader: null,
    hearingImpaired: false,
    fps: null,
    downloadCount: 0,
    hashMatch: false,
    fromTrusted: false,
    rating: null,
    votes: null,
    ...over,
  };
}

const FILE = "The.Others.2001.1080p.BluRay.x264-SPARKS.mkv";

test("release groups are read off the end of a name", () => {
  assert.equal(releaseGroup(FILE), "sparks");
  assert.equal(releaseGroup("The Others (2001) [1080p] [BluRay] [YTS.MX].mp4"), "ytsmx");
  assert.equal(releaseGroup("The.Others.2001.DVDRip"), null);
  assert.equal(releaseGroup("Movie.2001.x264"), null);
});

test("same release: the same group, or a name mostly like the file's", () => {
  assert.equal(releaseMatch(FILE, c(1, { release: "The.Others.2001.BDRip.x264-SPARKS" })).sameGroup, true);
  const near = releaseMatch(FILE, c(2, { release: "The.Others.2001.1080p.BluRay.x264" }));
  assert.equal(near.sameGroup, false);
  assert.equal(near.sameRelease, true);
  assert.equal(releaseMatch(FILE, c(3, { release: "The Others 2001 DVDRip XviD-FLAWL3SS" })).sameRelease, false);
});

test("best guess first: synced to the file, then same release, then trusted, rated, downloads", () => {
  const order = rankChoices(
    [
      c(1, { downloadCount: 90_000 }),
      c(2, { fromTrusted: true, downloadCount: 10 }),
      c(3, { hashMatch: true }),
      c(4, { release: "The.Others.2001.BRRip.x264-SPARKS" }),
      c(5, { fromTrusted: true, rating: 9, votes: 5 }),
      c(6, { rating: 10, votes: 1, downloadCount: 100_000 }),
    ],
    FILE,
  ).map((x) => x.candidate.fileId);
  assert.deepEqual(order, [3, 4, 5, 2, 6, 1]);
});

test("hearing-impaired ones are kept, after their plain equals", () => {
  const order = rankChoices([c(1, { hearingImpaired: true, downloadCount: 9 }), c(2, { downloadCount: 1 })], FILE).map(
    (x) => x.candidate.fileId,
  );
  assert.deepEqual(order, [2, 1]);
});

test("tags say why, in words", () => {
  const [top] = rankChoices([c(1, { hashMatch: true, fromTrusted: true, rating: 8, votes: 4, downloadCount: 1234, release: "The.Others.2001.720p-SPARKS" })], FILE);
  assert.deepEqual(top!.tags, ["synced to this file", "same release group as your file", "trusted uploader", "rated 8/10", "1,234 downloads"]);
  assert.deepEqual(choiceTags(c(2, { hearingImpaired: true, rating: 9, votes: 1 })), ["hearing impaired", "0 downloads"]);
});

test("a chosen subtitle never overwrites one already there", () => {
  const taken = new Set(["/m/The Others (2001)/The Others.eng.srt", "/m/The Others (2001)/The Others.2.eng.srt"]);
  assert.equal(chosenSubtitlePath("/m/The Others (2001)/The Others.mkv", () => false), "/m/The Others (2001)/The Others.eng.srt");
  assert.equal(chosenSubtitlePath("/m/The Others (2001)/The Others.mkv", (p) => taken.has(p)), "/m/The Others (2001)/The Others.3.eng.srt");
});
