import assert from "node:assert/strict";
import { test } from "node:test";

import { guessVersionLabel } from "./version-label.ts";

test("reads the cut from this library's real filenames", () => {
  assert.equal(
    guessVersionLabel("/media/Horror/Hell House LLC (2015) [DIRECTORS CUT]/Hell.House.LLC.2015.DIRECTORS.CUT.1080p.BluRay.x264.AAC-[YTS.BZ].mp4"),
    "Director's cut",
  );
  assert.equal(guessVersionLabel("Miracolo.A.Milano.1951.ITALIAN.1080p.BluRay.H264.AAC-VXT.mp4"), "Italian version");
  assert.equal(guessVersionLabel("Miracle.In.Milan.1951.REMASTERED.1080p.BluRay.x264.AAC-[YTS.MX].mp4"), "Remastered");
  assert.equal(
    guessVersionLabel(
      "Stazione Termini (1953) di Vittorio De Sica - English original version with ITA subtitles (1080p_24fps_H264-128kbit_AAC-Italian).mp4",
    ),
    "English version",
  );
  assert.equal(guessVersionLabel("Operazione paura - Kill Baby Kill (1966).H264.ita.eng-MIRCrew.mkv"), "Italian version");
  assert.equal(guessVersionLabel("Europa.51.1952.Criterion.1080p.BluRay.x265.HEVC.FLAC-SARTRE.mkv"), "Criterion");
});

test("says nothing when the name says nothing", () => {
  assert.equal(guessVersionLabel("Hell.House.LLC.2015.1080p.WEBRip.x264-[YTS.AM].mp4"), null);
  assert.equal(guessVersionLabel("Garibaldi.1961.1080p.BluRay.H264.AAC-RARBG.mp4"), null);
});

test("words inside other words don't count", () => {
  assert.equal(guessVersionLabel("The.Italian.Job.1969.mp4"), "Italian version", "a known limit: titles containing a language");
  assert.equal(guessVersionLabel("Credit.Card.Heist.mp4"), null, "'dc' only as a word");
});
