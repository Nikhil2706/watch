import assert from "node:assert/strict";
import { test } from "node:test";

import { alikeSuffix, defaultShiftPicks, subtitleSuffix } from "./subtitle-show-shift.ts";

test("a subtitle's suffix is what its name adds to the video's", () => {
  assert.equal(subtitleSuffix("/m/S1/Show.S01E02.HDTV.mkv", "Show.S01E02.HDTV.eng.srt"), ".eng.srt");
  assert.equal(subtitleSuffix("/m/S1/Show.S01E02.HDTV.mkv", "Show.S01E02.HDTV.2.eng.srt"), ".2.eng.srt");
  assert.equal(subtitleSuffix("/m/S1/Show.S01E02.HDTV.mkv", "Show.S01E02.HDTV.srt"), ".srt");
});

test("the files named like the one just synced are ticked; the rest offered unticked", () => {
  const picks = defaultShiftPicks({ videoPath: "/m/S1/Show.S01E01.mkv", name: "Show.S01E01.eng.srt" }, [
    { itemId: "e2", path: "/m/S1/Show.S01E02.mkv", label: "S1 E2", files: ["Show.S01E02.eng.srt", "Show.S01E02.srt"] },
    { itemId: "e3", path: "/m/S1/Show.S01E03.x264.mp4", label: "S1 E3", files: ["Show.S01E03.x264.ENG.srt"] },
  ]);
  assert.deepEqual(picks, {
    "e2\nShow.S01E02.eng.srt": true,
    "e2\nShow.S01E02.srt": false,
    "e3\nShow.S01E03.x264.ENG.srt": true,
  });
});

test("an English tag counts as no tag", () => {
  assert.equal(alikeSuffix(".eng.srt"), ".srt");
  assert.equal(alikeSuffix(".EN.srt"), ".srt");
  assert.equal(alikeSuffix(".2.eng.srt"), ".2.srt");
  assert.equal(alikeSuffix(".fre.srt"), ".fre.srt");
});

test("a file synced as .srt ticks the others' .eng.srt (Nathan For You)", () => {
  const picks = defaultShiftPicks({ videoPath: "/m/S1/Show.S01E01.mkv", name: "Show.S01E01.srt" }, [
    { itemId: "e2", path: "/m/S1/Show.S01E02.mkv", label: "S1 E2", files: ["Show.S01E02.eng.srt", "Show.S01E02.fre.srt"] },
    { itemId: "e3", path: "/m/S1/Show.S01E03.mkv", label: "S1 E3", files: ["Show.S01E03.srt", "Show.S01E03.eng.srt"] },
  ]);
  assert.deepEqual(picks, {
    "e2\nShow.S01E02.eng.srt": true,
    "e2\nShow.S01E02.fre.srt": false,
    "e3\nShow.S01E03.srt": true,
    "e3\nShow.S01E03.eng.srt": false,
  });
});
