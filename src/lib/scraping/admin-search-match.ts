/**
 * How well a library title answers what the curator typed, kept apart from
 * the search itself so it can be tested. Both sides are already through
 * normaliseTitle(): lower case, single spaces, no punctuation.
 *
 * Words are matched one by one, anywhere, because the text an episode is
 * found by is its show, its code and its own title run together — "buffy the
 * vampire slayer s04e10 hush". Asking for the typed phrase as one unbroken
 * run made "buffy s04" and "buffy hush" find nothing, which left the first
 * thirty episodes of a show as the only ones a search could reach.
 */

/** 0: not a match. 1: every word is there. 2: the phrase as typed. 3: it opens the title. */
export type MatchScore = 0 | 1 | 2 | 3;

export function matchScore(title: string, query: string): MatchScore {
  if (!query) return 0;
  if (title.startsWith(query)) return 3;
  if (title.includes(query)) return 2;
  return query.split(" ").every((word) => title.includes(word)) ? 1 : 0;
}

/**
 * The best `limit` of `hits`, closest match first. Hits that match equally
 * well stay in the order they arrived in, which is the library's own.
 */
export function bestMatches<T extends { score: MatchScore }>(hits: T[], limit: number): T[] {
  return hits
    .map((hit, index) => ({ hit, index }))
    .sort((a, b) => b.hit.score - a.hit.score || a.index - b.index)
    .slice(0, limit)
    .map(({ hit }) => hit);
}
