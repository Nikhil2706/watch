import assert from "node:assert/strict";
import { test } from "node:test";

import { defaultShiftPicks, subtitleSuffix } from "./subtitle-show-shift.ts";

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
