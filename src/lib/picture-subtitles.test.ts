import assert from "node:assert/strict";
import { test } from "node:test";

import { choosePictureBurn, isPictureCodec, parseSubtitleRequest, type PictureTrack } from "./picture-subtitles.ts";

/** Angel S1, as Jellyfin lists it: five DVD tracks, Danish marked default by the file. */
const ANGEL: PictureTrack[] = [
  { index: 2, label: "Danish", language: "dan", isForced: false },
  { index: 3, label: "English", language: "eng", isForced: false },
  { index: 4, label: "Finnish", language: "fin", isForced: false },
  { index: 5, label: "Norwegian", language: "nor", isForced: false },
  { index: 6, label: "Swedish", language: "swe", isForced: false },
];

test("DVD and Blu-ray codecs are pictures; text codecs are not", () => {
  for (const c of ["DVDSUB", "dvdsub", "PGSSUB", "hdmv_pgs_subtitle", "dvbsub", "vobsub"]) assert.equal(isPictureCodec(c), true, c);
  for (const c of ["subrip", "srt", "ass", "webvtt", "mov_text", "", null, undefined]) assert.equal(isPictureCodec(c), false, String(c));
});

test("no text subtitle: the English picture track, not the file's Danish default", () => {
  assert.equal(choosePictureBurn({ pictures: ANGEL, textDefault: false, requested: null }), 3);
});

test("a text subtitle to show: nothing burned in beside it", () => {
  assert.equal(choosePictureBurn({ pictures: ANGEL, textDefault: true, requested: null }), null);
});

test("no English picture track: none, rather than another language", () => {
  assert.equal(choosePictureBurn({ pictures: ANGEL.filter((p) => p.language !== "eng"), textDefault: false, requested: null }), null);
});

test("English forced-only is used when it is the only English", () => {
  const forced: PictureTrack[] = [{ index: 7, label: "English (Forced)", language: "eng", isForced: true }, ...ANGEL.filter((p) => p.language !== "eng")];
  assert.equal(choosePictureBurn({ pictures: forced, textDefault: false, requested: null }), 7);
  const both: PictureTrack[] = [forced[0]!, { index: 8, label: "English", language: "en", isForced: false }];
  assert.equal(choosePictureBurn({ pictures: both, textDefault: false, requested: null }), 8);
});

test("the viewer's pick from the menu wins: a picture track, Danish included", () => {
  assert.equal(choosePictureBurn({ pictures: ANGEL, textDefault: true, requested: 2 }), 2);
});

test("off, or a text track picked, burns nothing", () => {
  assert.equal(choosePictureBurn({ pictures: ANGEL, textDefault: false, requested: "off" }), null);
  assert.equal(choosePictureBurn({ pictures: ANGEL, textDefault: true, requested: 9 }), null);
});

test("?sub= reads an index or off; anything else is no request", () => {
  assert.equal(parseSubtitleRequest("3"), 3);
  assert.equal(parseSubtitleRequest("off"), "off");
  assert.equal(parseSubtitleRequest(["4", "5"]), 4);
  for (const junk of [undefined, "", "-1", "3x", "english"]) assert.equal(parseSubtitleRequest(junk), null, String(junk));
});
