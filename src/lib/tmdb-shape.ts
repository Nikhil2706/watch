/**
 * The shaping of a TMDB payload, with no database and no network in it.
 *
 * Same reason art-shape.ts and episode-gaps.ts are separate from the modules
 * that use them: the interesting decisions here are pure functions of some
 * JSON, and they are worth testing directly rather than through a store.
 *
 * Two decisions live here. Which credits survive — TMDB returns everything it
 * holds, including 1,102 stunt performers across this library, and the film
 * page can name six crew jobs. And what counts as a usable image path, which
 * matters because that string ends up in an outbound fetch.
 */

/** The six crew jobs a page can name, and a browse facet could be built on. */
export type CrewBucket =
  | "directors"
  | "writers"
  | "cinematographers"
  | "composers"
  | "editors"
  | "productionDesigners";

/** A department slug as stored: the six buckets, plus cast. */
export type Department = "cast" | CrewBucket;

/**
 * Which TMDB job strings land in which bucket.
 *
 * More than one spelling per bucket because TMDB genuinely uses both — the
 * same role is "Director of Photography" on one film and "Cinematography" on
 * another, and a film credited only the second way would otherwise vanish from
 * a row that exists to show it.
 */
export const CREW_JOBS: Record<CrewBucket, readonly string[]> = {
  directors: ["Director"],
  writers: ["Screenplay", "Writer", "Story", "Author"],
  cinematographers: ["Director of Photography", "Cinematography"],
  composers: ["Original Music Composer", "Music"],
  editors: ["Editor"],
  productionDesigners: ["Production Design", "Art Direction"],
};

const JOB_BUCKETS: Map<string, CrewBucket> = (() => {
  const out = new Map<string, CrewBucket>();
  for (const bucket of Object.keys(CREW_JOBS) as CrewBucket[]) {
    for (const job of CREW_JOBS[bucket]) out.set(job, bucket);
  }
  return out;
})();

/** Which bucket a TMDB job string belongs to, or null for the 1,102 stunt credits. */
export function bucketForJob(job: string): CrewBucket | null {
  return JOB_BUCKETS.get(job) ?? null;
}

/** How many cast members are worth keeping. The film page shows 20. */
const CAST_LIMIT = 20;

export interface ShapedCredit {
  tmdbId: number;
  name: string;
  profilePath: string | null;
  department: Department;
  /** The crew job, or the character name for cast. */
  job: string;
  ord: number;
}

interface RawCredit {
  id?: number;
  name?: string;
  character?: string;
  job?: string;
  profile_path?: string | null;
  order?: number;
}

interface CreditsPayload {
  /** A film's credits, from append_to_response. */
  credits?: { cast?: RawCredit[]; crew?: RawCredit[] };
  /** A show's, which TMDB names differently and rolls up across episodes. */
  aggregate_credits?: { cast?: RawCredit[]; crew?: RawCredit[] };
}

/** Everyone worth keeping out of one cached TMDB payload. */
export function creditsFromPayload(payload: unknown): ShapedCredit[] {
  const raw = payload as CreditsPayload | null;
  const source = raw?.credits ?? raw?.aggregate_credits;
  if (!source) return [];

  const out: ShapedCredit[] = [];
  // Keyed on person AND department AND job, matching tmdb_credits' primary
  // key. One person legitimately holds two credits on the same title —
  // Clouzot directed The Wages of Fear and co-wrote it, and Pablo Rosso shot
  // [REC] while also appearing in it — and both should survive.
  const seen = new Set<string>();

  const push = (c: RawCredit, department: Department, job: string, ord: number): void => {
    if (typeof c.id !== "number" || !c.name) return;
    const key = `${c.id} ${department} ${job}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      tmdbId: c.id,
      name: c.name,
      profilePath: c.profile_path ?? null,
      department,
      job,
      ord,
    });
  };

  // TMDB already returns cast in billing order, so the slice is the top of the
  // bill rather than an arbitrary twenty.
  (source.cast ?? []).slice(0, CAST_LIMIT).forEach((c, i) => {
    push(c, "cast", c.character ?? "", c.order ?? i);
  });

  for (const c of source.crew ?? []) {
    if (!c.job) continue;
    const bucket = JOB_BUCKETS.get(c.job);
    if (!bucket) continue;
    push(c, bucket, c.job, 0);
  }

  return out;
}

/**
 * Whether a string is plausibly one of TMDB's own image paths.
 *
 * The value arrives from a cached payload rather than from a request, but it
 * is still interpolated into an outbound URL, so it is checked rather than
 * trusted. TMDB's form is a leading slash, a base62 name and an extension —
 * which rules out traversal, a query string, and a protocol-relative host.
 */
const IMAGE_PATH_RE = /^\/[A-Za-z0-9]+\.(jpg|png|svg)$/;

export function isCacheableImagePath(path: string): boolean {
  return IMAGE_PATH_RE.test(path);
}
