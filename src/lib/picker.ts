/**
 * "Choose something for me" — the scoring and sampling, with no I/O.
 *
 * Pure and free of `server-only` so it runs under the test runner, the same
 * split browse-filters.ts / browse-data.ts already uses here, and for the same
 * reason that split records: a decade bug survived unnoticed because the logic
 * was not importable by a test.
 *
 * Nothing in this module writes anything, and nothing it computes outlives the
 * request — see the privacy note in DESIGN-choose-for-me.md. A stored taste
 * profile "for performance" would turn this into the viewing-metrics feature
 * that was deliberately parked.
 *
 * A note on this library specifically. Measured on 2026-09-07: zero star
 * ratings, eight list entries in total, two played titles out of four hundred.
 * The taste profile is therefore empty for almost everybody, and the cold-start
 * path is the ordinary path rather than an edge case. What this library does
 * have is the curator's own writing: article_film_links resolves 330 distinct
 * films by IMDb id. That is why `articleCount` is a first-class term here and
 * not a garnish — on a cold profile it is the only thing separating one
 * well-regarded film from another.
 */

export interface PickCandidate {
  /** Jellyfin item id, or a synthetic group id when isGroup. */
  id: string;
  title: string;
  year: number | null;
  genres: string[];
  directors: string[];
  actors: string[];
  /** basePopularity() from browse-data — a Bayesian weighted rating. */
  popularity: number;
  seen: boolean;
  href: string;
  isGroup: boolean;
  /** How many of the curator's articles link to this film. The strongest signal this library actually has. */
  articleCount: number;
  /** Fraction watched, 0-1, when the viewer has started it. */
  progress?: number;
  /** Jellyfin ticks, for the "something short" constraint. Null when unknown. */
  runtimeTicks?: number | null;
}

export interface TasteSignals {
  /** Items the viewer favourited or marked for rewatch — the strongest explicit positive. */
  likedIds: Set<string>;
  /** Star ratings, 1-10. 7+ is a positive, 4 and under a negative. */
  ratings: Map<string, number>;
  /** Items the viewer has played to completion. */
  playedIds: Set<string>;
  /** Started past a few minutes, under 20% watched, and left alone. */
  abandonedIds: Set<string>;
}

export interface TasteProfile {
  genres: Map<string, number>;
  directors: Map<string, number>;
  actors: Map<string, number>;
  decades: Map<number, number>;
  /** Item ids the viewer has told us, one way or another, that they do not want. */
  negatives: Set<string>;
  /** True when there was nothing to learn from — drives the cold-start copy. */
  isCold: boolean;
}

export type PickMode = "new" | "finish" | "again" | "random";

export interface ScoredPick {
  candidate: PickCandidate;
  score: number;
  /** One line, from the top-contributing term. The difference between a magic button and a random one. */
  reason: string;
}

const W_GENRE = 1.0;
const W_DIRECTOR = 1.6;
const W_ACTOR = 0.7;
const W_DECADE = 0.5;
const W_POPULARITY = 1.2;
const W_CURATOR = 1.4;
const PENALTY_ABANDONED = 2.5;
const PENALTY_LOW_RATED = 3.0;

/** IMDb-ish ratings sit around 5-9; this maps them to roughly 0-1. */
function normalisePopularity(p: number): number {
  return Math.max(0, Math.min(1, (p - 4) / 5));
}

function decadeOf(year: number | null): number | null {
  return year == null ? null : Math.floor(year / 10) * 10;
}

function bump<K>(m: Map<K, number>, k: K, by: number): void {
  m.set(k, (m.get(k) ?? 0) + by);
}

/**
 * Turn the viewer's own signals into weights over genres, people and decades.
 *
 * Positives are explicit lists, high ratings and completed plays; a list entry
 * counts for more than a play because it took a deliberate action. Negatives
 * are low ratings and abandonment — the design calls abandonment the most
 * informative signal available, and it costs nothing to read.
 */
export function buildTasteProfile(
  candidates: readonly PickCandidate[],
  signals: TasteSignals,
): TasteProfile {
  const profile: TasteProfile = {
    genres: new Map(),
    directors: new Map(),
    actors: new Map(),
    decades: new Map(),
    negatives: new Set(),
    isCold: true,
  };

  const byId = new Map(candidates.map((c) => [c.id, c]));

  const learn = (id: string, weight: number) => {
    const c = byId.get(id);
    if (!c) return;
    profile.isCold = false;
    for (const g of c.genres) bump(profile.genres, g, weight);
    for (const d of c.directors) bump(profile.directors, d, weight);
    // Top-billed only: a weight over every credited extra is noise.
    for (const a of c.actors.slice(0, 8)) bump(profile.actors, a, weight * 0.5);
    const dec = decadeOf(c.year);
    if (dec != null) bump(profile.decades, dec, weight);
  };

  for (const id of signals.likedIds) learn(id, 2);
  for (const id of signals.playedIds) learn(id, 1);
  for (const [id, stars] of signals.ratings) {
    if (stars >= 7) learn(id, 1.5);
    if (stars <= 4) profile.negatives.add(id);
  }
  for (const id of signals.abandonedIds) profile.negatives.add(id);

  return profile;
}

function affinity(values: readonly string[], weights: Map<string, number>, cap: number): number {
  if (weights.size === 0 || values.length === 0) return 0;
  let best = 0;
  for (const v of values) best = Math.max(best, weights.get(v) ?? 0);
  // Saturating rather than linear: liking five noirs should not make the sixth
  // outrank everything else in the library by arithmetic alone.
  return Math.min(1, best / cap);
}

/**
 * Score every candidate against the profile.
 *
 * Returns them scored but unsorted-by-chance — `pickSlate` does the sampling.
 * Splitting those two apart is what makes the scoring testable without a seed.
 */
export function scoreCandidates(
  candidates: readonly PickCandidate[],
  profile: TasteProfile,
): ScoredPick[] {
  const maxArticles = Math.max(1, ...candidates.map((c) => c.articleCount));

  return candidates.map((candidate) => {
    const genreScore = affinity(candidate.genres, profile.genres, 4);
    const directorScore = affinity(candidate.directors, profile.directors, 3);
    const actorScore = affinity(candidate.actors.slice(0, 8), profile.actors, 3);
    const dec = decadeOf(candidate.year);
    const decadeWeight = dec == null ? 0 : (profile.decades.get(dec) ?? 0);
    const decadeScore = Math.min(1, decadeWeight / 4);
    const popScore = normalisePopularity(candidate.popularity);
    const curatorScore = candidate.articleCount > 0 ? Math.min(1, candidate.articleCount / maxArticles) : 0;

    let score =
      W_GENRE * genreScore +
      W_DIRECTOR * directorScore +
      W_ACTOR * actorScore +
      W_DECADE * decadeScore +
      W_POPULARITY * popScore +
      W_CURATOR * curatorScore;

    if (profile.negatives.has(candidate.id)) {
      score -= candidate.progress != null ? PENALTY_ABANDONED : PENALTY_LOW_RATED;
    }

    // Pick the term that contributed most, and say that.
    const terms: Array<[number, string]> = [
      [W_DIRECTOR * directorScore, topMatch(candidate.directors, profile.directors, (n) => `${n} again.`)],
      [W_GENRE * genreScore, topMatch(candidate.genres, profile.genres, (n) => `More ${n.toLowerCase()}, which you keep coming back to.`)],
      [W_ACTOR * actorScore, topMatch(candidate.actors.slice(0, 8), profile.actors, (n) => `Because you have watched ${n}.`)],
      [W_DECADE * decadeScore, dec == null ? "" : `From the ${dec}s, which you keep coming back to.`],
      [W_CURATOR * curatorScore, curatorScore > 0 ? "He has written about this one." : ""],
      [W_POPULARITY * popScore * 0.6, "One of the better-regarded things on the shelf."],
    ];
    terms.sort((a, b) => b[0] - a[0]);
    const reason = terms.find(([weight, text]) => weight > 0 && text)?.[1] ?? "A shot in the dark.";

    return { candidate, score, reason };
  });
}

function topMatch(
  values: readonly string[],
  weights: Map<string, number>,
  phrase: (name: string) => string,
): string {
  let best: string | null = null;
  let bestWeight = 0;
  for (const v of values) {
    const w = weights.get(v) ?? 0;
    if (w > bestWeight) {
      bestWeight = w;
      best = v;
    }
  }
  return best ? phrase(best) : "";
}

/** mulberry32 — small, fast, and seedable so a slate is reproducible in a test. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SlateOptions {
  seed: number;
  size?: number;
  /** Ids already offered this sitting. Held by the client, never stored here. */
  exclude?: ReadonlySet<string>;
  /** Higher is more adventurous. The one number worth tuning by feel. */
  temperature?: number;
  /** How deep to sample from. */
  poolSize?: number;
}

/**
 * Sample a slate rather than taking the maximum.
 *
 * Argmax kills the feature on the second press: same input, same film, forever.
 * Softmax over the top of the ranking with a temperature knob is the entire
 * user experience.
 *
 * Returns a whole slate, not one pick, so re-rolling walks it client-side —
 * instant, and no way for a stuck client to hammer Jellyfin.
 */
export function pickSlate(scored: readonly ScoredPick[], options: SlateOptions): ScoredPick[] {
  const { seed, size = 10, exclude, temperature = 0.6, poolSize = 25 } = options;
  const rand = seededRandom(seed);

  let pool = scored.filter((s) => !exclude?.has(s.candidate.id));
  if (pool.length === 0) return [];

  pool = [...pool].sort((a, b) => b.score - a.score).slice(0, Math.max(size, poolSize));

  const out: ScoredPick[] = [];
  const remaining = [...pool];

  while (out.length < size && remaining.length > 0) {
    // Softmax over what is left. Shifting by the max keeps exp() in range for
    // scores that a penalty has driven well negative.
    const max = Math.max(...remaining.map((r) => r.score));
    const weights = remaining.map((r) => Math.exp((r.score - max) / Math.max(0.01, temperature)));
    const total = weights.reduce((a, b) => a + b, 0);

    let roll = rand() * total;
    let chosen = remaining.length - 1;
    for (let i = 0; i < remaining.length; i += 1) {
      roll -= weights[i]!;
      if (roll <= 0) {
        chosen = i;
        break;
      }
    }
    out.push(remaining[chosen]!);
    remaining.splice(chosen, 1);
  }

  return out;
}

/**
 * The cold-start line. Said plainly, because a brand-new invitee being told
 * "because you liked X" about a film they have never heard of is worse than
 * being told the truth.
 */
export const COLD_START_REASON =
  "You have not watched anything here yet, so this one is a house favourite.";

export function applyColdStart(picks: ScoredPick[], profile: TasteProfile): ScoredPick[] {
  if (!profile.isCold) return picks;
  return picks.map((p) => ({
    ...p,
    reason: p.candidate.articleCount > 0 ? "He has written about this one." : COLD_START_REASON,
  }));
}
