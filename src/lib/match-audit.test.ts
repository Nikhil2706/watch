import assert from "node:assert/strict";
import { test } from "node:test";

import {
  auditFilm,
  normaliseTitle,
  titleFromFilename,
  type AuditCandidate,
} from "./match-audit.ts";

/**
 * The case this exists for is real: [Rec].2.2009.1080p.BluRay.mkv is identified
 * by Jellyfin as The Descent: Part 2. It was found by eye. The point of the
 * audit is that the next one is not.
 */

const film = (o: Partial<AuditCandidate>): AuditCandidate => ({
  libraryTitle: "Something",
  filename: null,
  libraryYear: null,
  tmdbTitle: "Something",
  tmdbOriginalTitle: null,
  tmdbYear: null,
  alternativeTitles: [],
  ...o,
});

test("titles normalise past punctuation, case and articles", () => {
  assert.equal(normaliseTitle("The Descent: Part 2"), "descent part 2");
  assert.equal(normaliseTitle("[REC]²"), "rec");
  // Accents are stripped rather than discarded: "Samouraï" becomes "samourai",
  // not "samoura". The earlier behaviour dropped the letter entirely, which is
  // what made "Celine" and "Céline" look like different films.
  assert.equal(normaliseTitle("Le Samouraï"), "samourai");
  assert.equal(normaliseTitle("Céline and Julie"), normaliseTitle("Celine And Julie"));
  assert.equal(normaliseTitle("Joan the Maid II"), normaliseTitle("Joan The Maid 2"));
});

test("a filename gives up its title", () => {
  assert.equal(titleFromFilename("[Rec].2.2009.1080p.BluRay.x264-[YTS.LT].mp4"), "[Rec] 2");
  assert.equal(titleFromFilename("REC.2007.SPANISH.REPACK.1080p.BluRay.x264.AAC5.1-[YTS.MX].mp4"), "REC");
  assert.equal(titleFromFilename("Memento (2000) [1080p].mkv"), "Memento");
});

/* ---- the real failure ---- */

test("the [Rec] 2 mis-identification is flagged", () => {
  const finding = auditFilm(
    film({
      libraryTitle: "The Descent: Part 2",
      filename: "[Rec].2.2009.1080p.BluRay.x264-[YTS.LT].mp4",
      libraryYear: 2009,
      tmdbTitle: "The Descent: Part 2",
      tmdbYear: 2009,
      alternativeTitles: ["The Descent 2"],
    }),
  );
  // Title and year agree with each other — it is the FILENAME that disagrees,
  // which is exactly why the filename has to be part of the judgement.
  assert.equal(finding.verdict, "check");
  assert.match(finding.why, /filename reads as/);
});

test("a correct film is silent", () => {
  const finding = auditFilm(
    film({
      libraryTitle: "Memento",
      filename: "Memento (2000) [1080p].mkv",
      libraryYear: 2000,
      tmdbTitle: "Memento",
      tmdbYear: 2000,
    }),
  );
  assert.equal(finding.verdict, "agrees");
  assert.equal(finding.score, 0);
});

test("a legitimately translated title is not flagged, because alternatives cover it", () => {
  const finding = auditFilm(
    film({
      libraryTitle: "Acts of the Apostles",
      libraryYear: 1969,
      tmdbTitle: "Atti degli apostoli",
      tmdbOriginalTitle: "Atti degli apostoli",
      tmdbYear: 1969,
      alternativeTitles: ["Acts of the Apostles", "Die Apostelgeschichte"],
    }),
  );
  assert.equal(finding.verdict, "agrees", "an alternative title is still the right film");
});

test("the original title alone is enough to agree", () => {
  const finding = auditFilm(
    film({ libraryTitle: "Ran", tmdbTitle: "乱", tmdbOriginalTitle: "Ran", tmdbYear: 1985, libraryYear: 1985 }),
  );
  assert.equal(finding.verdict, "agrees");
});

test("a wrong film with a wrong year is suspect, not merely worth a check", () => {
  const finding = auditFilm(
    film({
      libraryTitle: "Some Other Film",
      filename: "Actual.Movie.1972.1080p.mkv",
      libraryYear: 2015,
      tmdbTitle: "Some Other Film",
      tmdbYear: 1972,
    }),
  );
  assert.equal(finding.verdict, "suspect");
  assert.match(finding.why, /year differs/);
});

test("a title with an extra suffix is treated as the same film", () => {
  // "Memento" is a shortening of "Memento (Remastered)", so this now agrees
  // outright rather than needing the filename to rescue it — the same rule that
  // stops "Duelle" being flagged against "Duelle (Une Quarantaine)".
  const finding = auditFilm(
    film({
      libraryTitle: "Memento (Remastered)",
      filename: "Memento.2000.1080p.BluRay.mkv",
      libraryYear: 2000,
      tmdbTitle: "Memento",
      tmdbYear: 2000,
    }),
  );
  assert.equal(finding.verdict, "agrees");
});

test("a subtitle dropped by the filename is not a disagreement", () => {
  const finding = auditFilm(
    film({
      libraryTitle: "Duelle (Une Quarantaine)",
      filename: "Duelle.1976.1080p.BluRay.x264.mp4",
      libraryYear: 1976,
      tmdbTitle: "Duelle (Une Quarantaine)",
      tmdbYear: 1976,
    }),
  );
  assert.equal(finding.verdict, "agrees", "the file just omits the subtitle");
});

test("a genuinely different film in the file is still caught", () => {
  // The real one this run found: the library says The French Connection, the
  // file is Chocolat.mp4.
  const finding = auditFilm(
    film({
      libraryTitle: "The French Connection",
      filename: "Chocolat.mp4",
      libraryYear: 1971,
      tmdbTitle: "The French Connection",
      tmdbYear: 1971,
    }),
  );
  assert.notEqual(finding.verdict, "agrees");
  assert.match(finding.why, /Chocolat/);
});

test("one year out is tolerated, since release years legitimately disagree", () => {
  const finding = auditFilm(
    film({ libraryTitle: "A Film", libraryYear: 1999, tmdbTitle: "A Film", tmdbYear: 2000 }),
  );
  assert.equal(finding.verdict, "agrees");
});

test("a missing year is not evidence of anything", () => {
  const finding = auditFilm(film({ libraryTitle: "A Film", tmdbTitle: "A Film", libraryYear: null, tmdbYear: null }));
  assert.equal(finding.verdict, "agrees");
});

test("a missing filename does not crash the judgement", () => {
  const finding = auditFilm(film({ libraryTitle: "Odd Name", tmdbTitle: "Different Name", filename: null }));
  assert.equal(finding.verdict, "check");
});

test("the reason is always readable, because a score alone cannot be acted on", () => {
  for (const f of [
    film({ libraryTitle: "X", tmdbTitle: "Y" }),
    film({ libraryTitle: "X", tmdbTitle: "X" }),
  ]) {
    assert.ok(auditFilm(f).why.length > 0);
  }
});
