/**
 * How much does the library's idea of a film disagree with TMDB's?
 *
 * Phase 2, and a prerequisite for the same reason phase 1 is: before TMDB data
 * drives a page, it is worth knowing where it describes a different film from
 * the one on disk.
 *
 * The known case is `[Rec].2.2009.1080p.BluRay.mkv`, which Jellyfin identified
 * as *The Descent: Part 2*. Nothing surfaced that; it was found by eye while
 * looking for something else. There are 390 cached films and no reason to think
 * it is the only one.
 *
 * The signal is alternative titles, present on 81% of cached films. A film's
 * Jellyfin name should match TMDB's title, its original title, or one of its
 * regional alternatives. When it matches none of them, either the identification
 * is wrong or the title is unusual — and the filename usually says which.
 *
 * Pure and free of server-only, so the scoring is testable against the real
 * cases rather than asserted.
 */

export interface AuditCandidate {
  /** What the library calls it. */
  libraryTitle: string;
  /** The file's own name, which is often more honest than the matched title. */
  filename: string | null;
  libraryYear: number | null;
  /** TMDB's primary title. */
  tmdbTitle: string;
  tmdbOriginalTitle: string | null;
  tmdbYear: number | null;
  alternativeTitles: readonly string[];
}

export type AuditVerdict = "agrees" | "check" | "suspect";

export interface AuditFinding {
  verdict: AuditVerdict;
  /** 0 = perfect agreement, higher = more suspicious. */
  score: number;
  why: string;
}

/**
 * Punctuation, articles, accents, case and numbering style are all noise.
 *
 * Every one of these was learned from a false alarm on the real library. The
 * first run over 390 films flagged "Celine And Julie Go Boating" against
 * "Céline and Julie Go Boating" (accents) and "Joan The Maid 1" against
 * "Joan the Maid I" (numbering) — plainly the same films, and exactly the noise
 * that would have buried the one genuine mis-identification the run found.
 */
const ROMAN: Record<string, string> = {
  i: "1", ii: "2", iii: "3", iv: "4", v: "5",
  vi: "6", vii: "7", viii: "8", ix: "9", x: "10",
};

export function normaliseTitle(name: string): string {
  return name
    // NFKD rather than NFD: it also folds compatibility forms, so the "²" in
    // "[REC]²" becomes a 2 and matches a file called "[Rec].2". NFD left it as a
    // symbol the next line turned into a space, and the real title disagreed
    // with its own file.
    .normalize("NFKD")
    // Strip combining accents, so é and e are the same letter.
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[._'`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(the|a|an|le|la|les|il|lo|el|der|die|das|und|and|et)\b/g, " ")
    .split(/\s+/)
    .map((w) => ROMAN[w] ?? w)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Is one title a reasonable shortening of the other?
 *
 * A filename routinely drops a subtitle — "Duelle" for "Duelle (Une
 * Quarantaine)", "I - Le Jour" for a two-part documentary's episode name. That
 * is not a disagreement about which film it is, and counting it as one is how
 * the signal drowns.
 *
 * The shorter side must be a whole-word prefix of at least four characters, so
 * a stray "I" cannot match everything.
 */
function isShorteningOf(a: string, b: string): boolean {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length < 4) return false;
  return long === short || long.startsWith(short + " ");
}

/** Words that number a part of a series, compared the way digits are. */
const NUMBERING_WORDS = new Set([
  "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "first", "second", "third", "fourth", "fifth",
  "part", "chapter", "episode", "vol", "volume",
]);

function hasNumbering(words: readonly string[]): boolean {
  return words.some((w) => /\d/.test(w) || NUMBERING_WORDS.has(w));
}

/** Levenshtein distance. Titles are short, so the plain version is plenty. */
function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const above = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length]!;
}

/**
 * Do two normalised titles name the same film?
 *
 * The strict tests -- equality, or a dropped subtitle -- came first and still run
 * first. Every rule after them exists because of a specific false alarm on the
 * live audit of 2026-09-10, where 8 of 15 findings were a correctly identified
 * film whose filename the audit could not read. Each rule is fenced so that it
 * cannot excuse what the audit is for, a file holding a different film from the
 * one it is filed as. In particular none of them lets two titles that differ
 * only in a number agree: a wrong sequel is the mis-identification that looks
 * most like a match.
 */
export function titlesAgree(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b || isShorteningOf(a, b)) return true;

  // Spacing only. "Ro.Go.Pa.G." normalises to "rogopag" while the file's dots
  // become spaces, "ro go pa g"; "L'Amore" against "L.amore" is the same case.
  const compactA = a.replace(/ /g, "");
  const compactB = b.replace(/ /g, "");
  if (compactA.length >= 4 && compactA === compactB) return true;

  const wordsA = a.split(" ");
  const wordsB = b.split(" ");
  const [shortWords, longWords] =
    wordsA.length <= wordsB.length ? [wordsA, wordsB] : [wordsB, wordsA];
  const short = shortWords.join(" ");

  // The END of a longer title. A file keeps "II - La Nuit" of "Jacques Rivette,
  // le veilleur: 2-La nuit", or "Siamo Donne" after an actor's name. Two words
  // at least, so a bare numeral cannot match every sequel going.
  if (
    shortWords.length >= 2 &&
    short.length >= 4 &&
    longWords.slice(longWords.length - shortWords.length).join(" ") === short
  ) {
    return true;
  }

  // A long shared opening: "How to Live in the FRG" for "How to Live in the
  // German Federal Republic". Three words and most of the shorter title, and
  // nothing numbered after the point where they part -- otherwise "Part One"
  // and "Part Two" of the same series would agree.
  let shared = 0;
  while (shared < shortWords.length && shortWords[shared] === longWords[shared]) shared += 1;
  if (
    shared >= 3 &&
    shared / shortWords.length >= 0.6 &&
    !hasNumbering(shortWords.slice(shared)) &&
    !hasNumbering(longWords.slice(shared))
  ) {
    return true;
  }

  // One letter apart in a title long enough for that to be spelling: "Europe
  // '51" and "Europa '51". The digits have to match exactly, which is what stops
  // this ever turning Toy Story 2 into Toy Story 3.
  if (
    wordsA.length === wordsB.length &&
    a.length >= 6 &&
    a.replace(/\D/g, "") === b.replace(/\D/g, "") &&
    editDistance(a, b) <= 1
  ) {
    return true;
  }

  return false;
}

/**
 * Strip release noise from a filename to get at the title it claims to be.
 *
 * Reuses the same idea as episode-naming.ts: everything from the first quality
 * or codec token onward is not part of a title.
 */
const RELEASE_NOISE =
  /\b(1080p|2160p|720p|480p|4k|uhd|web[- ]?dl|webrip|bluray|blu[- ]?ray|brrip|bdrip|dvdrip|hdrip|hdtv|x264|x265|h ?264|h ?265|hevc|avc|aac\d*|ac3|dts|remux|proper|repack|amzn|nf|hulu|dsnp|multi|dual|yts|rarbg)\b/i;

export function titleFromFilename(filename: string): string {
  // Underscores and pluses are word breaks. Left in, they glued "_H264_" and
  // "+1953_" to their neighbours, so neither the release-noise cut nor the year
  // cut could find a word boundary and the whole name survived as the "title" --
  // "Anna+Magnani_Siamo+Donne+1953_SD_H264_Ita_Ac3..." on the live audit.
  const stem = filename.replace(/\.[a-z0-9]{2,4}$/i, "").replace(/[_+]+/g, " ");
  const cut = RELEASE_NOISE.exec(stem);
  let text = cut ? stem.slice(0, cut.index) : stem;
  // "Harun Farocki - (1990) How to Live in the FRG": a name, a dash, a year,
  // and then the title. Cutting at the year below would keep the director and
  // throw the title away.
  const byLine = /^(.+?)\s+-\s+[([]?(?:19|20)\d{2}[)\]]?\s+(.+)$/.exec(text);
  if (byLine) return byLine[2]!.replace(/[._]+/g, " ").replace(/\s+/g, " ").trim();
  // A trailing year in brackets or bare is a year, not part of the title.
  text = text.replace(/[([]?\b(19|20)\d{2}\b[)\]]?.*$/, "");
  return text.replace(/[._]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Does the library's title appear anywhere in TMDB's set of names for it?
 *
 * Checked against the primary title, the original title, and every regional
 * alternative — which is what makes this workable for a library where a French
 * or Japanese film is legitimately held under a translated name.
 */
function matchesAnyKnownTitle(libraryTitle: string, c: AuditCandidate): boolean {
  const target = normaliseTitle(libraryTitle);
  if (!target) return false;
  const known = [c.tmdbTitle, c.tmdbOriginalTitle ?? "", ...c.alternativeTitles];
  return known.some((k) => {
    if (!k) return false;
    const n = normaliseTitle(k);
    return titlesAgree(n, target);
  });
}

const YEAR_TOLERANCE = 1;

/**
 * Judge one film.
 *
 * Deliberately three-valued rather than a boolean. "Suspect" is for a
 * disagreement strong enough to act on; "check" is for one worth a human
 * glance; "agrees" is silence. A binary would either bury the real cases among
 * unusual-but-correct titles, or cry wolf often enough to be ignored — and an
 * audit nobody reads is worse than none, because it looks like coverage.
 */
export function auditFilm(c: AuditCandidate): AuditFinding {
  const reasons: string[] = [];
  let score = 0;

  const titleAgrees = matchesAnyKnownTitle(c.libraryTitle, c);

  if (!titleAgrees) {
    score += 2;
    reasons.push("library title matches none of TMDB's names for it");
  }

  // The filename is the strongest independent witness: nobody renames a file to
  // agree with a wrong match, so when the filename says one thing and the
  // matched title says another, the filename is usually right.
  if (c.filename) {
    const fromFile = titleFromFilename(c.filename);
    if (fromFile) {
      const fileAgreesWithTmdb = matchesAnyKnownTitle(fromFile, c);
      const fileAgreesWithLibrary = titlesAgree(normaliseTitle(fromFile), normaliseTitle(c.libraryTitle));

      if (!titleAgrees && fileAgreesWithTmdb) {
        // The file says what TMDB says; only the library's stored name is odd.
        // That is a cosmetic mismatch, not a wrong identification.
        score -= 1;
        reasons.push("but the filename agrees with TMDB");
      } else if (!fileAgreesWithTmdb && !fileAgreesWithLibrary) {
        score += 2;
        reasons.push(`filename reads as "${fromFile}", which matches neither`);
      } else if (!fileAgreesWithTmdb && fileAgreesWithLibrary && !titleAgrees) {
        score += 1;
        reasons.push("filename and library agree with each other but not with TMDB");
      }
    }
  }

  if (c.libraryYear != null && c.tmdbYear != null) {
    const gap = Math.abs(c.libraryYear - c.tmdbYear);
    if (gap > YEAR_TOLERANCE) {
      score += gap >= 5 ? 2 : 1;
      reasons.push(`year differs by ${gap} (${c.libraryYear} vs ${c.tmdbYear})`);
    }
  }

  const verdict: AuditVerdict = score >= 3 ? "suspect" : score >= 2 ? "check" : "agrees";
  return {
    verdict,
    score: Math.max(0, score),
    why: reasons.length ? reasons.join("; ") : "title and year agree with TMDB",
  };
}
