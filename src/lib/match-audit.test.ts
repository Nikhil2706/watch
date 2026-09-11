import assert from "node:assert/strict";
import { test } from "node:test";

import {
  auditFilm,
  normaliseTitle,
  titleFromFilename,
  titlesAgree,
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
  // The superscript is the sequel's number, not decoration: NFKD reads it as a
  // 2, which is what lets the [REC]² file agree with a library title of "[REC] 2"
  // while still disagreeing with plain "[REC]".
  assert.equal(normaliseTitle("[REC]²"), "rec 2");
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

/* ------------------------------------------------------------------ *
 * The live audit's false alarms, 2026-09-10
 *
 * Eight of fifteen findings were correctly identified films whose filenames the
 * audit could not read. Each case below is one of them, real filename and all.
 * The tests after them are the other half: the same rules must not excuse a
 * file that really is a different film.
 * ------------------------------------------------------------------ */

test("dotted titles agree with their spaced-out filenames", () => {
  const f = auditFilm(film({
    libraryTitle: "Ro.Go.Pa.G.",
    tmdbTitle: "Ro.Go.Pa.G.",
    filename: "Ro.Go.Pa.G..1963.1080p.BluRay.x264.AAC-[YTS.MX].mp4",
  }));
  assert.equal(f.verdict, "agrees");
});

test("an apostrophe that became a dot is not a different film", () => {
  const f = auditFilm(film({
    libraryTitle: "L'Amore",
    tmdbTitle: "L'Amore",
    filename: "L.amore.1948.ITALIAN.1080p.BluRay.H264.AAC-VXT.mp4",
  }));
  assert.equal(f.verdict, "agrees");
});

test("a superscript is the digit it looks like", () => {
  assert.equal(normaliseTitle("[REC]²"), normaliseTitle("[Rec] 2"));
  const f = auditFilm(film({
    libraryTitle: "[REC]²",
    tmdbTitle: "[REC]²",
    filename: "[Rec].2.2009.1080p.BluRay.x264-[YTS.LT].mp4",
  }));
  assert.equal(f.verdict, "agrees");
});

test("a filename that leads with the director still gives up the title", () => {
  assert.equal(
    titleFromFilename("Harun Farocki - (1990) How to Live in the FRG.mkv"),
    "How to Live in the FRG",
  );
  const f = auditFilm(film({
    libraryTitle: "How to Live in the German Federal Republic",
    tmdbTitle: "How to Live in the German Federal Republic",
    filename: "Harun Farocki - (1990) How to Live in the FRG.mkv",
  }));
  assert.equal(f.verdict, "agrees");
});

test("a filename keeping only the end of a long title agrees", () => {
  const f = auditFilm(film({
    libraryTitle: "Jacques Rivette le veilleur: 2-La nuit",
    tmdbTitle: "Jacques Rivette le veilleur: 2-La nuit",
    filename: "II - La Nuit.mkv",
  }));
  assert.equal(f.verdict, "agrees");
});

test("underscores and pluses no longer glue a whole filename into its title", () => {
  const f = auditFilm(film({
    libraryTitle: "We, the Women",
    tmdbTitle: "We, the Women",
    tmdbOriginalTitle: "Siamo donne",
    filename: "Anna+Magnani_Siamo+Donne+1953_SD_H264_Ita_Ac3_2_0_BaMax71_MIRCrew.mkv",
  }));
  assert.equal(f.verdict, "agrees");
});

test("a translation one letter apart is the same film", () => {
  const f = auditFilm(film({
    libraryTitle: "Europa '51",
    tmdbTitle: "Europa '51",
    filename: "Europe.'51.1952.1080p.BluRay.x264-[YTS.AG].mp4",
  }));
  assert.equal(f.verdict, "agrees");
});

test("a wrong sequel is still caught, whichever rule might have excused it", () => {
  const f = auditFilm(film({
    libraryTitle: "Toy Story 2",
    tmdbTitle: "Toy Story 2",
    libraryYear: 1999,
    tmdbYear: 1999,
    filename: "Toy.Story.3.2010.1080p.BluRay.x264.mp4",
  }));
  assert.notEqual(f.verdict, "agrees");
  // Five shared opening words, but the parts are numbered, so no.
  assert.equal(
    titlesAgree(
      normaliseTitle("Mission: Impossible - Dead Reckoning Part One"),
      normaliseTitle("Mission: Impossible - Dead Reckoning Part Two"),
    ),
    false,
  );
});

test("the swapped Rivette parts are still told apart", () => {
  const f = auditFilm(film({
    libraryTitle: "Jacques Rivette le veilleur: 1-Le jour",
    tmdbTitle: "Jacques Rivette le veilleur: 1-Le jour",
    filename: "II - La Nuit.mkv",
  }));
  assert.notEqual(f.verdict, "agrees");
});

test("a genuinely different film survives every new rule", () => {
  const f = auditFilm(film({
    libraryTitle: "The French Connection",
    tmdbTitle: "The French Connection",
    filename: "Chocolat.mp4",
  }));
  assert.notEqual(f.verdict, "agrees");
  assert.equal(titlesAgree("chocolat", "french connection"), false);
});
