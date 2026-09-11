/**
 * Which extra shelves the home page shows today.
 *
 * Three kinds, each only possible because TMDB is now in the store: a crew
 * shelf ("Shot by William Lubtchansky"), a keyword shelf ("Found Footage"), and
 * a franchise shelf ("Resident Evil"). Measured on the live library, 2026-09-10:
 * 23 cinematographers, 17 composers and 23 editors have four or more films
 * here, 98 keywords reach five, and 7 TMDB collections have two or more owned
 * titles. So there is far more than a home page can show at once.
 *
 * The answer is rotation: one shelf of each kind, chosen by the day. Stable for
 * a whole day — so the page does not reshuffle between two visits an hour
 * apart, and the result caches well — and different tomorrow, so a library of
 * this size gets walked through over a couple of months rather than always
 * showing its three biggest names.
 *
 * Pure and importless so the choosing can be tested on its own.
 */

export type ShelfKind = "franchise" | "crew" | "keyword";

export interface ShelfCandidate {
  kind: ShelfKind;
  /** Stable identity: a TMDB person or collection id, or the keyword itself. */
  key: string;
  /** The row's heading, already worded. */
  title: string;
  /** Library file paths on the shelf, in the order they should appear. */
  paths: readonly string[];
}

/**
 * The smallest a shelf may be. Below this a row reads as an accident — a
 * two-film "shelf" for a cinematographer is a coincidence, not a body of work —
 * but two films really are a franchise.
 */
export const MIN_SHELF_SIZE: Record<ShelfKind, number> = {
  franchise: 2,
  crew: 4,
  keyword: 5,
};

/** The order the kinds appear on the page: the most specific first. */
const KIND_ORDER: readonly ShelfKind[] = ["franchise", "crew", "keyword"];

/**
 * Different kinds step through their lists at different rates, so the page
 * does not change all three shelves in lockstep and repeat the same pairing
 * every n days.
 */
const KIND_STEP: Record<ShelfKind, number> = { franchise: 1, crew: 7, keyword: 13 };

/** Days since the epoch — the rotation's clock. */
export function daySeed(now: number = Date.now()): number {
  return Math.floor(now / 86_400_000);
}

/**
 * One shelf per kind for the given day, or fewer when a kind has nothing big
 * enough. Deterministic: the same candidates and seed always give the same
 * shelves, whatever order the candidates arrive in.
 */
export function pickShelves(candidates: readonly ShelfCandidate[], seed: number): ShelfCandidate[] {
  const out: ShelfCandidate[] = [];
  for (const kind of KIND_ORDER) {
    const pool = candidates
      .filter((c) => c.kind === kind && c.paths.length >= MIN_SHELF_SIZE[kind])
      // Sorted on the key so the pick depends on the seed, not on whatever
      // order the database happened to return rows in today.
      .slice()
      .sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
    if (pool.length === 0) continue;
    const index = ((seed * KIND_STEP[kind]) % pool.length + pool.length) % pool.length;
    out.push(pool[index]!);
  }
  return out;
}

/**
 * Keywords that are not a shelf.
 *
 * TMDB's keywords are a mix of subjects, production metadata and, since 2023,
 * mood adjectives — and the live top-forty was dominated by the wrong two:
 * "based on novel or book" (30), "woman director", "duringcreditsstinger",
 * "bewildered". Some are also simply not something to put on a home page as a
 * heading, whatever they describe.
 */
const NOT_A_SHELF = new Set([
  // Production metadata: true of the film, not what it is about.
  "based on novel or book", "based on true story", "based on comic", "based on play or musical",
  "based on video game", "based on short story", "based on memoir or autobiography",
  "based on young adult novel", "based on manga", "based on tv series", "sequel", "prequel",
  "remake", "reboot", "spin off", "duringcreditsstinger", "aftercreditsstinger", "woman director",
  "short film", "3d animation", "black and white", "silent film", "biography", "independent film",
  "live action remake", "anthology", "documentary", "part of a series",
  // Too broad to mean anything as a shelf of its own.
  "love", "friendship", "murder", "death", "family", "revenge", "money", "flashback",
  "husband wife relationship", "sibling relationship", "father son relationship",
  "mother daughter relationship", "female protagonist", "male protagonist", "violence",
  // Not a heading to meet on a home page.
  "suicide", "rape", "sexual abuse", "child abuse", "drug addiction", "self-harm", "incest",
  "nazi", "holocaust", "genocide", "torture",
]);

/** TMDB's mood tags: adjectives, not subjects. */
const MOODS = new Set([
  "intense", "bewildered", "suspenseful", "dramatic", "romantic", "inspirational", "hopeful",
  "somber", "tense", "cautionary", "admiring", "amused", "anxious", "awestruck", "sad", "sincere",
  "bold", "defiant", "cheerful", "playful", "witty", "complex", "critical", "disturbing",
  "frightened", "horrified", "melancholy", "ominous", "provocative", "reflective", "sentimental",
  "thoughtful", "vindictive", "celebratory", "dreary", "compassionate", "excited", "joyous",
  "gloomy", "empathetic", "enthusiastic", "exuberant", "hilarious", "audacious", "absurd",
  "aggressive", "angry", "antagonistic", "appreciative", "approving", "arrogant", "assertive",
  "authoritarian", "baffled", "callous", "candid", "clinical", "comforting", "condescending",
  "contemptuous", "cynical", "depressing", "didactic", "earnest", "embarrassed", "familiar",
  "farcical", "harsh", "hateful", "hopeless", "incredulous", "informative", "introspective",
  "ironic", "kinetic", "lighthearted", "loving", "mean spirited", "mischievous", "mocking",
  "nostalgic", "optimistic", "powerful", "pretentious", "proud", "quirky", "reverent",
  "sarcastic", "satirical", "scathing", "shocking", "sinister", "skeptical", "sympathetic",
  "tragic", "uplifting", "whimsical", "wistful",
]);

export function isShelfKeyword(name: string): boolean {
  const k = name.trim().toLowerCase();
  if (k.length < 3) return false;
  return !NOT_A_SHELF.has(k) && !MOODS.has(k);
}

/** Words that should stay capitals in a heading. */
const KEEP_UPPER = new Set(["ii", "iii", "iv", "vi", "vii", "viii", "ix", "usa", "uk", "lgbt", "lgbtq", "fbi", "cia", "nyc", "ai"]);

/**
 * "new york city" -> "New York City", "world war ii" -> "World War II",
 * "neo-noir" -> "Neo-Noir". Keywords arrive lower-case.
 */
export function keywordHeading(name: string): string {
  return name
    .trim()
    .split(/(\s+|-)/)
    .map((part) => {
      if (/^\s+$/.test(part) || part === "-") return part;
      if (KEEP_UPPER.has(part.toLowerCase())) return part.toUpperCase();
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join("");
}

/** "Resident Evil Collection" -> "Resident Evil". */
export function franchiseHeading(collectionName: string): string {
  return collectionName.replace(/\s+collection$/i, "").trim();
}

/** How a crew shelf is worded, by department. */
export const CREW_SHELF_VERB: Record<string, string> = {
  cinematographers: "Shot by",
  composers: "Scored by",
  editors: "Cut by",
};
