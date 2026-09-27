/**
 * Choosing which TMDB show a library group actually is.
 *
 * Taking the first search result is wrong often enough to be dangerous. Run
 * against this library it matched "E.R." (308 files) to *Trauma: Life in the
 * E.R.* (75 episodes), "The Curse" (10 files) to *The Curse of Oak Island*
 * (258 episodes), and "Parallel" (4 files) to *Parallel Me*. Three wrong out of
 * twelve — and because the next step is stamping episode stills onto files, a
 * wrong match does not degrade politely: it puts a stranger's artwork on 308
 * episodes and looks deliberate.
 *
 * Two signals, both cheap and already to hand:
 *
 * 1. **Name.** Normalised equality is worth a lot. "The Curse" vs "The Curse of
 *    Oak Island" shares a prefix and nothing else, which is precisely the trap
 *    a substring test falls into.
 * 2. **Episode count against the number of files.** This is the strong one. A
 *    group of 308 files is not a 75-episode show. It tolerates a library that
 *    is missing episodes or has extras, but rules out being wrong by an order
 *    of magnitude.
 *
 * When nothing scores well the answer is no answer. An unlinked group is a
 * visible, fixable state; a confidently wrong link is not.
 *
 * Pure and free of server-only, so the judgement can be tested against the real
 * cases above rather than argued about.
 */

export interface ShowCandidate {
  id: number;
  name: string;
  episodeCount: number | null;
  firstAirYear: number | null;
  /**
   * Every other name TMDB knows this show by, when the caller has fetched
   * them. Absent for a bare search result, which does not carry them.
   */
  alternativeNames?: readonly string[];
  /**
   * Episodes per season (season number → count), from the detail fetch.
   * When present, the fit is judged against only the seasons the library
   * holds, which is what separates two shows with the same name.
   */
  seasonEpisodes?: Readonly<Record<number, number>>;
}

export interface ShowMatch {
  candidate: ShowCandidate;
  score: number;
  confident: boolean;
  why: string;
  /** How far files/episodes is from 1 — breaks ties between equal scores. */
  gap: number;
}

/** Lowercase, strip punctuation and articles, collapse space. "E.R." and "ER" are the same show. */
export function normaliseShowName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[._']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(the|a|an)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * How well a candidate's episode count fits the number of files we hold.
 *
 * 1 when they match; falls away as the ratio diverges. Deliberately forgiving
 * downward — holding 10 of a 22-episode season is normal — and unforgiving
 * upward, because holding more files than the show has episodes means it is
 * almost certainly a different show.
 */
export function countFit(files: number, episodes: number | null): number {
  if (!episodes || episodes <= 0 || files <= 0) return 0.5; // unknown, so neutral
  const ratio = files / episodes;
  if (ratio > 1.15) return Math.max(0, 1 - (ratio - 1) * 1.5); // more files than episodes
  if (ratio >= 0.5) return 1;
  return Math.max(0, ratio * 1.6);
}

const NAME_EXACT = 3;
const NAME_PREFIX = 0.4;
const COUNT_WEIGHT = 2.5;

/**
 * Confidence needs an EXACT normalised name, not just a good score.
 *
 * A prefix match plus a plausible episode count was enough to link "Parallel"
 * (4 files) to *Parallel Me* (8 episodes), which is the same shape of error as
 * The Curse of Oak Island — just less obvious. The risk here is asymmetric: an
 * unlinked group is a visible state a person fixes in one step, while a
 * confident wrong link puts another show's artwork on every episode and looks
 * intentional. So a shared prefix contributes to ranking but can never, alone,
 * authorise acting.
 *
 * The cost is honest and worth stating: a group whose TMDB title is a
 * translation ("Atti Degli Apostoli" against *Acts of the Apostles*, "la lotta
 * dell'uomo per la sua sopravvivenza" against *Man's Struggle for Survival*)
 * will not auto-link and has to be linked by hand. Two manual links beats three
 * hundred wrong stills.
 */
const MIN_COUNT_FIT_TO_ACT = 0.6;

/**
 * Which episode count to hold the files against, or null when the candidate
 * cannot be this show at all.
 *
 * Heroes is why this exists: a search for it returns the 2006 American series
 * (4 seasons, 77 episodes) and a 2020 Chinese one (1 season, ~40), both named
 * exactly "Heroes". Against a library holding season 1 — 23 files — the whole
 * -show count picked the Chinese show (23/40 fits better than 23/77). Against
 * the seasons actually held it is 23 vs 23 and not close. And files reaching a
 * season the show doesn't have rule it out outright.
 */
function comparableEpisodes(
  candidate: ShowCandidate,
  seasons: readonly number[] | undefined,
): { episodes: number | null; missingSeason: number | null } {
  const per = candidate.seasonEpisodes;
  if (!per || !seasons || seasons.length === 0) return { episodes: candidate.episodeCount, missingSeason: null };
  let total = 0;
  for (const s of seasons) {
    const n = per[s];
    if (n == null) return { episodes: null, missingSeason: s };
    total += n;
  }
  return { episodes: total, missingSeason: null };
}

export function scoreShowCandidate(
  candidate: ShowCandidate,
  group: { name: string; fileCount: number; seasons?: readonly number[] },
): ShowMatch {
  const a = normaliseShowName(group.name);
  const b = normaliseShowName(candidate.name);

  let nameScore = 0;
  let nameWhy = "name does not match";
  if (a === b) {
    nameScore = NAME_EXACT;
    nameWhy = "exact name";
  } else if ((candidate.alternativeNames ?? []).some((n) => normaliseShowName(n) === a)) {
    // An EXACT match against one of TMDB's own alternative titles, which is
    // what a translated group needs: "Atti Degli Apostoli" is exactly what
    // TMDB lists *Acts of the Apostles* as in Italy. This is deliberately
    // scored the same as an exact primary-name match and NOT as a prefix —
    // the rule being kept is "exact, or it cannot authorise acting", and an
    // alternative title is still exact. The count fit still has to agree.
    nameScore = NAME_EXACT;
    nameWhy = "exact match on an alternative title";
  } else if (b.startsWith(a + " ") || a.startsWith(b + " ")) {
    // "The Curse" vs "The Curse of Oak Island" lands here, and NAME_PREFIX is
    // deliberately small so the episode count has to rescue it.
    nameScore = NAME_PREFIX;
    nameWhy = "one name contains the other";
  }

  const { episodes, missingSeason } = comparableEpisodes(candidate, group.seasons);
  const fit = missingSeason != null ? 0 : countFit(group.fileCount, episodes);
  const score = nameScore + fit * COUNT_WEIGHT;

  const countWhy =
    missingSeason != null
      ? `files reach season ${missingSeason}, which this show does not have`
      : episodes == null
        ? "episode count unknown"
        : `${group.fileCount} files vs ${episodes} episodes${candidate.seasonEpisodes && group.seasons?.length ? " in the seasons held" : ""}`;

  return {
    candidate,
    score,
    confident: nameScore === NAME_EXACT && fit >= MIN_COUNT_FIT_TO_ACT,
    why: `${nameWhy}, ${countWhy}`,
    gap: episodes && missingSeason == null ? Math.abs(1 - group.fileCount / episodes) : Number.POSITIVE_INFINITY,
  };
}

/**
 * The best candidate, or null when none is good enough to act on.
 *
 * Returning null is a feature. The caller leaves the group unlinked and says
 * so, which a person can fix in one step — far better than silently stamping
 * the wrong show's artwork across a season.
 */
export function pickBestShowMatch(
  candidates: readonly ShowCandidate[],
  group: { name: string; fileCount: number; seasons?: readonly number[] },
): ShowMatch | null {
  if (candidates.length === 0) return null;
  // Equal scores are common: countFit is flat across 0.5–1.15, so 23 files
  // score the same against 23 episodes as against 40. The closer count wins.
  const scored = candidates
    .map((c) => scoreShowCandidate(c, group))
    .sort((x, y) => y.score - x.score || x.gap - y.gap);
  const best = scored[0]!;
  return best.confident ? best : null;
}
