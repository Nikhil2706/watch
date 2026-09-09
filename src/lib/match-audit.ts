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
    .normalize("NFD")
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

/**
 * Strip release noise from a filename to get at the title it claims to be.
 *
 * Reuses the same idea as episode-naming.ts: everything from the first quality
 * or codec token onward is not part of a title.
 */
const RELEASE_NOISE =
  /\b(1080p|2160p|720p|480p|4k|uhd|web[- ]?dl|webrip|bluray|blu[- ]?ray|brrip|bdrip|dvdrip|hdrip|hdtv|x264|x265|h ?264|h ?265|hevc|avc|aac\d*|ac3|dts|remux|proper|repack|amzn|nf|hulu|dsnp|multi|dual|yts|rarbg)\b/i;

export function titleFromFilename(filename: string): string {
  const stem = filename.replace(/\.[a-z0-9]{2,4}$/i, "");
  const cut = RELEASE_NOISE.exec(stem);
  let text = cut ? stem.slice(0, cut.index) : stem;
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
    return n === target || isShorteningOf(n, target);
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
      const fileAgreesWithLibrary = normaliseTitle(fromFile) === normaliseTitle(c.libraryTitle);

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
