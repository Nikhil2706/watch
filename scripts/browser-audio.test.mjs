import { test } from "node:test";
import assert from "node:assert/strict";

import { defaultAudio, mp4SubtitlesBlock, needsBrowserAudio, remuxArgs, verifyRemux } from "./browser-audio.mjs";

const v = { codec_type: "video", codec_name: "h264", pix_fmt: "yuv420p" };
const a = (codec_name, extra = {}) => ({ codec_type: "audio", codec_name, ...extra });
const s = (codec_name) => ({ codec_type: "subtitle", codec_name });

test("a DTS-only film needs a browser track", () => {
  const r = needsBrowserAudio([v, a("dts")], ".mkv");
  assert.equal(r.needed, true);
  assert.match(r.reason, /dts/);
});

test("several unplayable tracks still need one", () => {
  assert.equal(needsBrowserAudio([v, a("truehd"), a("ac3"), a("eac3")], ".mkv").needed, true);
});

test("a playable main track is enough", () => {
  for (const codec of ["aac", "mp3", "opus", "vorbis", "flac", "AAC"]) {
    assert.equal(needsBrowserAudio([v, a(codec), a("dts")], ".mkv").needed, false, codec);
  }
});

test("a playable track that isn't the main one doesn't count (Stop Making Sense)", () => {
  // DTS 5.1 default, then FLAC 2.0, then a commentary in AAC.
  const streams = [v, a("dts", { disposition: { default: 1 } }), a("flac"), a("aac")];
  assert.equal(needsBrowserAudio(streams, ".mkv").needed, true);
});

test("the main track is the default one, else the first", () => {
  assert.equal(defaultAudio([v, a("dts"), a("aac", { disposition: { default: 1 } })]), 1);
  assert.equal(defaultAudio([v, a("dts"), a("aac")]), 0);
  assert.equal(defaultAudio([v]), -1);
  assert.equal(needsBrowserAudio([v, a("dts"), a("aac", { disposition: { default: 1 } })], ".mkv").needed, false);
});

test("the new track is made from the default track", () => {
  const args = remuxArgs("in.mkv", ".t.mkv", [v, a("aac", { tags: { language: "fre" } }), a("dts", { disposition: { default: 1 }, tags: { language: "eng" } })], ".mkv");
  assert.ok(args.includes("0:a:1"));
  assert.ok(args.includes("language=eng"));
});

test("a picture that needs converting is left to the conversion", () => {
  const hevc = { codec_type: "video", codec_name: "hevc", pix_fmt: "yuv420p10le" };
  assert.equal(needsBrowserAudio([hevc, a("dts")], ".mkv").needed, false);
  const h264hi10 = { codec_type: "video", codec_name: "h264", pix_fmt: "yuv420p10le" };
  assert.equal(needsBrowserAudio([h264hi10, a("ac3")], ".mkv").needed, false);
  // Cover art (mjpeg) is not the picture.
  assert.equal(needsBrowserAudio([v, { codec_type: "video", codec_name: "mjpeg" }, a("ac3")], ".mkv").needed, true);
});

test("no sound, no track", () => {
  assert.equal(needsBrowserAudio([v], ".mkv").needed, false);
});

test("containers it does not rewrite are left alone", () => {
  assert.equal(needsBrowserAudio([v, a("dts")], ".avi").needed, false);
  assert.equal(needsBrowserAudio([v, a("dts")], ".MP4").needed, true);
});

test("the AAC track goes first, is the default, and every original follows", () => {
  const args = remuxArgs("in.mkv", ".tmp.mkv", [v, a("dts", { tags: { language: "eng" } }), a("ac3"), s("subrip")], ".mkv");
  const maps = args.flatMap((x, i) => (x === "-map" ? [args[i + 1]] : []));
  assert.deepEqual(maps, ["0:v?", "0:a:0", "0:a", "0:s?", "0:t?"]);
  assert.ok(args.join(" ").includes("-c copy -c:a:0 aac -ac:a:0 2"));
  assert.ok(args.includes("language=eng"));
  const dispo = args.flatMap((x, i) => (x.startsWith("-disposition:a:") ? [`${x}=${args[i + 1]}`] : []));
  assert.deepEqual(dispo, ["-disposition:a:0=default", "-disposition:a:1=0", "-disposition:a:2=0"]);
  assert.equal(args.at(-1), ".tmp.mkv");
});

test("MP4 gets faststart and no attachments", () => {
  const args = remuxArgs("in.mp4", ".tmp.mp4", [v, a("ac3")], ".mp4");
  assert.ok(args.includes("+faststart"));
  assert.ok(!args.includes("0:t?"));
});

const probe = (duration, streams) => ({ format: { duration: String(duration) }, streams });

test("a good remux passes", () => {
  const before = probe(6000, [v, a("dts"), s("subrip")]);
  const after = probe(6000.4, [v, a("aac", { channels: 2 }), a("dts"), s("subrip")]);
  assert.deepEqual(verifyRemux(before, after), { ok: true, reason: "ok" });
});

test("a short file, a lost track or a wrong first track fails", () => {
  const before = probe(6000, [v, a("dts"), s("subrip")]);
  assert.equal(verifyRemux(before, probe(5800, [v, a("aac", { channels: 2 }), a("dts"), s("subrip")])).ok, false);
  assert.equal(verifyRemux(before, probe(6000, [v, a("aac", { channels: 2 }), a("dts")])).ok, false);
  assert.equal(verifyRemux(before, probe(6000, [v, a("aac", { channels: 2 }), s("subrip")])).ok, false);
  assert.equal(verifyRemux(before, probe(6000, [v, a("aac", { channels: 6 }), a("dts"), s("subrip")])).ok, false);
  assert.equal(verifyRemux(before, null).ok, false);
});

test("MP4s with non-mov_text subtitles are not remuxed", () => {
  assert.equal(mp4SubtitlesBlock([v, a("ac3"), s("subrip")], ".mp4"), true);
  assert.equal(mp4SubtitlesBlock([v, a("ac3"), s("mov_text")], ".mp4"), false);
  assert.equal(mp4SubtitlesBlock([v, a("ac3"), s("subrip")], ".mkv"), false);
});
