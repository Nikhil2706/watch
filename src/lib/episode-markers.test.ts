/**
 * Tests for season/episode marker detection.
 *
 * Run:
 *   node --test --experimental-strip-types \
 *        --disable-warning=ExperimentalWarning src/lib/episode-markers.test.ts
 *
 * Every filename below is a real one from this library. Two of these shapes
 * were silently unsupported until E.R. was grouped: "03x02" matched nothing at
 * all (43 files), and "s01e01e02" matched nothing either, because the plain
 * S00E00 pattern's trailing word boundary fails against the second E.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { findEpisodeMarker } from "./episode-markers.ts";

test("reads the ordinary SxxEyy form", () => {
  const m = findEpisodeMarker("er.s01e03.Day.One.fs");
  assert.equal(m.season, 1);
  assert.equal(m.episode, 3);
});

test("reads a two-digit season and episode", () => {
  const m = findEpisodeMarker("er.s13e22.the.honeymoon.is.over");
  assert.equal(m.season, 13);
  assert.equal(m.episode, 22);
});

test("reads the NNxNN form", () => {
  const m = findEpisodeMarker("03x02 - Let the Games Begin");
  assert.equal(m.season, 3);
  assert.equal(m.episode, 2);
});

test("reads NNxNN without a leading zero", () => {
  const m = findEpisodeMarker("3x7 - Ghosts");
  assert.equal(m.season, 3);
  assert.equal(m.episode, 7);
});

test("a double episode is filed under the first of the pair", () => {
  // "s01e01e02" used to parse as nothing: S01E01 is in there, but the
  // pattern's trailing boundary fails against the E02 that follows.
  const m = findEpisodeMarker("er.s01e01e02.24.hours.fs");
  assert.equal(m.season, 1);
  assert.equal(m.episode, 1);
});

test("falls back to a bare episode number", () => {
  const m = findEpisodeMarker("Out 1 - Ep 4");
  assert.equal(m.season, null);
  assert.equal(m.episode, 4);
});

test("reports nothing when there is no marker", () => {
  const m = findEpisodeMarker("Black Sabbath 1963 1080p BluRay");
  assert.equal(m.season, null);
  assert.equal(m.episode, null);
});

test("endIndex points past the marker so the title can be taken after it", () => {
  const stem = "03x02 - Let the Games Begin";
  const m = findEpisodeMarker(stem);
  assert.equal(stem.slice(m.endIndex), " - Let the Games Begin");
});

test("a resolution is not mistaken for a season and episode", () => {
  // "1920x1080" must not read as season 1920 / episode 1080 — the season
  // group caps at two digits, so the match cannot start at the beginning.
  const m = findEpisodeMarker("some.film.1920x1080.bluray");
  assert.notEqual(m.season, 1920);
});

// --- The three conventions that matched nothing until 2026-09-26 -----------

test("reads a 3-digit season+episode between dashes, keeping the title after", () => {
  const stem = "Sports Night - 201 - Special Powers";
  const m = findEpisodeMarker(stem);
  assert.equal(m.season, 2);
  assert.equal(m.episode, 1);
  assert.equal(stem.slice(m.endIndex), "Special Powers");
});

test("a film called 300 is not season 3, episode 0", () => {
  const m = findEpisodeMarker("Frank Miller - 300 - Directors Cut");
  assert.equal(m.episode, null);
});

test("reads part N of a miniseries written with a fraction slash, as season 1", () => {
  const m = findEpisodeMarker("Atti degli apostoli 2⁄5 (1969) Roberto Rossellini eng sub");
  assert.equal(m.season, 1);
  assert.equal(m.episode, 2);
});

test("reads part N of a miniseries written with a hyphen", () => {
  // Real names, including the double space and the typo in "Engish".
  const cases: [string, number][] = [
    ["La lotta del uomo per la sua sopravvivenza  1-12  English subtitles (480p_25fps_H264-128kbit_AAC)", 1],
    ["La lotta dell'uomo per la sua sopravvivenza 2-12 English subtitles (480p_25fps_H264-128kbit_AAC)", 2],
    ["La lotta dell'uomo per la sua sopravvivenza 6-12  Engish subtitles (1080p_25fps_H264-128kbit_AAC-English)", 6],
    ["La lotta dell'uomo per la sua sopravvivenza 11-12  English subtitles (1080p_25fps_H264-128kbit_AAC)", 11],
  ];
  for (const [stem, part] of cases) {
    const m = findEpisodeMarker(stem);
    assert.equal(m.season, 1, stem);
    assert.equal(m.episode, part, stem);
  }
});

test("what follows a part marker is not taken as an episode title", () => {
  const stem = "La lotta dell'uomo per la sua sopravvivenza 10-12  English subtitles (480p)";
  assert.equal(stem.slice(findEpisodeMarker(stem).endIndex), "");
});

test("a part past its total, or a two-part hyphen, is not a part", () => {
  assert.equal(findEpisodeMarker("Something 13-12 cut").episode, null);
  // "1-2" is too easily something else; the fraction slash is unambiguous.
  assert.equal(findEpisodeMarker("Dune 1-2 extended").episode, null);
  assert.equal(findEpisodeMarker("Dune 1⁄2 extended").episode, 1);
});

test("years, resolutions and ranges inside words are not parts", () => {
  assert.equal(findEpisodeMarker("Some Film 1970-1972 (1080p_25fps)").episode, null);
  assert.equal(findEpisodeMarker("Film (480p_25fps_H264-128kbit_AAC)").episode, null);
});

test("a (2) duplicate-file suffix stays unparsed on purpose", () => {
  assert.equal(findEpisodeMarker("L'età di Cosimo de Medici (2)").episode, null);
});
