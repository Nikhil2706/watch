/**
 * Finding the season/episode marker in a filename.
 *
 * Split out of episode-naming.ts with ZERO imports, for the reason recorded at
 * the top of browse-filters.test.ts: a server-only module holding the SQLite
 * handle cannot be reached by a test, and that is how the Browse decade filter
 * stayed broken without anything noticing. This is pattern-matching against
 * filenames people actually have, so it is exactly the kind of thing that is
 * quietly wrong until someone checks — an "03x02" naming convention silently
 * matched nothing for 43 of E.R.'s files, which then could not be identified
 * at all.
 */

export interface EpisodeMarker {
  season: number | null;
  episode: number | null;
  /** Where the marker ended, so a caller can take the title fragment after it. */
  endIndex: number;
}

/*
 * The orderings that matter:
 *
 *  - the double-episode form (S01E01E02) is tried BEFORE the single, because
 *    "S01E01E02" also contains a valid "S01E01" but the plain pattern's
 *    trailing word boundary fails against the "E02" that follows, so the file
 *    parsed as nothing at all. The first number of a pair is the right answer:
 *    a double episode is filed under the earlier number everywhere.
 *  - "03x02" is tried before the bare "E7" form, since a bare-episode match
 *    could otherwise pick a number out of an unrelated part of the name.
 */
const DOUBLE_EPISODE = /\bS(\d{1,2})E(\d{1,3})E\d{1,3}\b/i;
const SEASON_EPISODE = /\bS(\d{1,2})E(\d{1,3})\b/i;
/** "3x07", "03x02" — season and episode either side of an x, no S or E at all. */
const CROSS_EPISODE = /\b(\d{1,2})x(\d{1,3})\b/i;
const BARE_EPISODE = /\bE(?:p(?:isode)?)?\.?\s*(\d{1,3})\b/i;

/*
 * Three conventions from the library that matched nothing, all tried last so
 * nothing that already parses can change:
 *
 *  - "Sports Night - 201 - Special Powers": season then two-digit episode as a
 *    3-digit number between spaced dashes. Episode 00 is refused, so a film
 *    titled "300" cannot become season 3.
 *  - "Atti degli apostoli 2⁄5": part of a miniseries, written with a fraction
 *    slash (U+2044) or division slash (U+2215) — a real "/" cannot be in a
 *    filename.
 *  - "La lotta dell'uomo per la sua sopravvivenza 10-12": the same with a
 *    hyphen. Riskier, so it needs whitespace on both sides, a total of at least
 *    3, and the part not past the total; years and resolutions cannot fit.
 *
 * A miniseries is filed as season 1, which is how TMDB models one and so how
 * the episode-stills plan finds it. What follows a part marker is not a title
 * ("English subtitles (480p…)"), so the whole name counts as consumed.
 *
 * Deliberately NOT here: a bare "(2)" / "(3)" suffix. In this library that is
 * a duplicate-file marker ("L'età di Cosimo de Medici (2)"), not a part.
 */
const DASHED_SEASON_EPISODE = /\s-\s([1-9])(\d{2})\s-\s/;
const PART_OF_SLASH = /(?:^|[^\d])(\d{1,2})\s?[⁄∕]\s?(\d{1,2})(?!\d)/;
const PART_OF_HYPHEN = /(?:^|\s)(\d{1,2})-(\d{1,2})(?=\s|$)/;

function partOf(match: RegExpExecArray | null, minTotal: number): number | null {
  if (!match) return null;
  const part = Number.parseInt(match[1] ?? "0", 10);
  const total = Number.parseInt(match[2] ?? "0", 10);
  return part >= 1 && total >= minTotal && part <= total ? part : null;
}

export function findEpisodeMarker(stem: string): EpisodeMarker {
  const double = DOUBLE_EPISODE.exec(stem);
  if (double) {
    return {
      season: Number.parseInt(double[1] ?? "0", 10),
      episode: Number.parseInt(double[2] ?? "0", 10),
      endIndex: double.index + double[0].length,
    };
  }

  const seasonEp = SEASON_EPISODE.exec(stem);
  if (seasonEp) {
    return {
      season: Number.parseInt(seasonEp[1] ?? "0", 10),
      episode: Number.parseInt(seasonEp[2] ?? "0", 10),
      endIndex: seasonEp.index + seasonEp[0].length,
    };
  }

  const cross = CROSS_EPISODE.exec(stem);
  if (cross) {
    return {
      season: Number.parseInt(cross[1] ?? "0", 10),
      episode: Number.parseInt(cross[2] ?? "0", 10),
      endIndex: cross.index + cross[0].length,
    };
  }

  const bare = BARE_EPISODE.exec(stem);
  if (bare) {
    return {
      season: null,
      episode: Number.parseInt(bare[1] ?? "0", 10),
      endIndex: bare.index + bare[0].length,
    };
  }

  const dashed = DASHED_SEASON_EPISODE.exec(stem);
  if (dashed && dashed[2] !== "00") {
    return {
      season: Number.parseInt(dashed[1] ?? "0", 10),
      episode: Number.parseInt(dashed[2] ?? "0", 10),
      endIndex: dashed.index + dashed[0].length,
    };
  }

  const part = partOf(PART_OF_SLASH.exec(stem), 2) ?? partOf(PART_OF_HYPHEN.exec(stem), 3);
  if (part !== null) {
    return { season: 1, episode: part, endIndex: stem.length };
  }

  return { season: null, episode: null, endIndex: 0 };
}
