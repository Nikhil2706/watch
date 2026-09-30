import assert from "node:assert/strict";
import { test } from "node:test";

import {
  pickFromFamily,
  releaseSignature,
  subtitleTextSimilarity,
  type SubtitleCandidate,
  type SubtitleFamily,
} from "./subtitle-match.ts";

const cand = (over: Partial<SubtitleCandidate>): SubtitleCandidate => ({
  fileId: 1,
  fileName: null,
  release: null,
  uploader: null,
  hearingImpaired: false,
  fps: null,
  downloadCount: 0,
  hashMatch: false,
  ...over,
});

test("every episode of a release family normalises to one signature", () => {
  assert.equal(releaseSignature("Heroes.S01E01.HDTV.XviD-LOL"), releaseSignature("Heroes.S01E05.HDTV.XviD-LOL"));
  assert.equal(releaseSignature("Heroes.1x01.hdtv-lol.VO"), releaseSignature("Heroes.1x14.hdtv-lol.VO"));
  assert.equal(releaseSignature("heroes.101.hdtv-lol.en"), releaseSignature("heroes.102.hdtv-lol.en"));
  assert.notEqual(releaseSignature("Heroes.S01E01.HDTV.XviD-LOL"), releaseSignature("Heroes.2006.HDDVD.S01E01.720p.x264-ESiR"));
});

// Real search results for Heroes S01E02, against a family identified from S01E01.
test("picks the same family for the next episode, not the most downloaded", () => {
  const family: SubtitleFamily = {
    uploader: "tictac_1987 (a)",
    release: "Heroes.S01E01.HDTV.XviD-LOL",
    fileName: "Heroes.1x01.hdtv-lol.VO",
    hearingImpaired: false,
    fps: 23.98,
  };
  const results = [
    cand({ fileId: 10, uploader: "eduo_", release: "Heroes.S01E02.HDTV.XviD-LOL", fileName: "Heroes.S01E02.HDTV.XviD-LOL", hearingImpaired: true, fps: 23.976, downloadCount: 90000 }),
    cand({ fileId: 11, uploader: "tictac_1987 (a)", release: "Heroes.S01E02.HDTV.XviD-LOL", fileName: "Heroes.1x02.hdtv-lol.VO", fps: 23.98, downloadCount: 60000 }),
    cand({ fileId: 12, uploader: "stanleyho74", release: "Heroes.2006.S01EAll.720p.HDDVD.x264-ESiR", fileName: "Heroes.2006.HDDVD.S01E02.720p.x264-ESiR.PROPER.eng", downloadCount: 40000 }),
  ];
  assert.equal(pickFromFamily(results, family)?.candidate.fileId, 11);
});

test("a subtitle synced to the file wins when the family is absent for that episode", () => {
  const family: SubtitleFamily = { uploader: "os-auto", release: "Nathan.For.You.S01E01.HDTV.XviD-AFG", fileName: null, hearingImpaired: false, fps: null };
  const results = [
    cand({ fileId: 20, uploader: "someone", release: "Nathan For You S01E03 random", downloadCount: 9000 }),
    cand({ fileId: 21, uploader: "other", release: "Nathan For You - 01x03 - Something.AFG.English", hashMatch: true, downloadCount: 100 }),
  ];
  assert.equal(pickFromFamily(results, family)?.candidate.fileId, 21);
});

test("nothing family enough means no pick, not the most popular", () => {
  const family: SubtitleFamily = { uploader: "tictac_1987 (a)", release: "Heroes.S01E01.HDTV.XviD-LOL", fileName: null, hearingImpaired: false, fps: null };
  const results = [cand({ fileId: 30, uploader: "stranger", release: "Heroes 1x03 - One Giant Leap", downloadCount: 99999 })];
  assert.equal(pickFromFamily(results, family), null);
});

test("text similarity ignores numbering, timing and tags", () => {
  const a = "1\n00:00:01,000 --> 00:00:02,000\n<i>Where are we going?</i>\n\n2\n00:00:03,000 --> 00:00:04,000\nTo save the cheerleader.\n";
  const b = "1\n00:00:01,500 --> 00:00:02,500\nWhere are we going?\n\n2\n00:00:03,500 --> 00:00:04,500\nTo save the cheerleader.\n";
  assert.equal(subtitleTextSimilarity(a, b), 1);
  assert.equal(subtitleTextSimilarity(a, "1\n00:00:01,000 --> 00:00:02,000\nSomething else entirely.\n"), 0);
});

test("a subtitle named for the episode's own release counts, even from another family", () => {
  // Nathan For You S01E03 is an EVOLVE file; the approved S01E01 was os-auto's AFG release.
  const family: SubtitleFamily = { uploader: "os-auto", release: "Nathan.For.You.S01E01.HDTV.XviD-AFG", fileName: null, hearingImpaired: false, fps: null };
  const results = [
    cand({ fileId: 40, uploader: "someone", release: "Nathan For You S01E03 random rip", downloadCount: 9000 }),
    cand({ fileId: 41, uploader: "other", release: "Nathan.For.You.S01E03.HDTV.x264-EVOLVE", downloadCount: 800 }),
  ];
  assert.equal(pickFromFamily(results, family, "Nathan.For.You.S01E03.HDTV.x264-EVOLVE.mp4")?.candidate.fileId, 41);
  assert.equal(pickFromFamily(results, family, null), null, "without the file's name there is nothing to go on");
});
