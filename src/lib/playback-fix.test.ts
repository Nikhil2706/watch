import { test } from "node:test";
import assert from "node:assert/strict";

import { playbackFix } from "./playback-fix.ts";

const v = (Codec: string, BitDepth = 8) => ({ Type: "Video", Codec, BitDepth });
const a = (Codec: string) => ({ Type: "Audio", Codec });

test("an .mkv or 4K H.264 with AAC needs nothing", () => {
  assert.equal(playbackFix([v("h264"), a("aac")]), null);
  assert.equal(playbackFix([v("vp9"), a("opus")]), null);
});

test("video a browser can't decode needs converting", () => {
  assert.deepEqual(playbackFix([v("mpeg4"), a("mp3")]), { fix: "convert", reason: "MPEG-4 Part 2 (DivX/Xvid) video" });
  assert.deepEqual(playbackFix([v("hevc", 10), a("aac")]), { fix: "convert", reason: "10-bit HEVC (H.265) video" });
  assert.deepEqual(playbackFix([v("h264", 10), a("aac")]), { fix: "convert", reason: "10-bit H.264 video" });
});

test("good video with an awkward main track needs browser audio, not conversion", () => {
  assert.deepEqual(playbackFix([v("h264"), a("ac3")]), { fix: "audio", reason: "main sound track is Dolby Digital (AC-3)" });
  assert.deepEqual(playbackFix([v("h264"), a("dts"), a("truehd")]), { fix: "audio", reason: "main sound track is DTS" });
});

test("a playable track that isn't the main one doesn't help (Stop Making Sense)", () => {
  assert.deepEqual(playbackFix([v("h264"), { ...a("dts"), IsDefault: true }, a("flac"), a("aac")]), { fix: "audio", reason: "main sound track is DTS" });
});

test("a playable main track, or no sound, needs nothing", () => {
  assert.equal(playbackFix([v("h264"), a("aac"), a("ac3")]), null);
  assert.equal(playbackFix([v("h264"), a("ac3"), { ...a("aac"), IsDefault: true }]), null);
  assert.equal(playbackFix([v("h264")]), null);
});

test("nothing probed as video is not judged", () => {
  assert.equal(playbackFix([a("mp3")]), null);
  assert.equal(playbackFix(undefined), null);
});
