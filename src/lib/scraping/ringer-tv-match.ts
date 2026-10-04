/**
 * Which show, and which episode, a piece of The Ringer's TV writing is about.
 * Pure, so it can be tested; ringer-tv.ts does the fetching and storing.
 *
 * matchTitle() (match.ts) cannot be used for this. It knows films only, and
 * a show's name is too often also a word or a film: "Lost", "Heroes",
 * "Fargo". So a show is matched only where the article itself marks a title
 * as a title — in the headline's quotation marks, which is how the site sets
 * every show's name, or at the front of the address with a word after it
 * that only television uses ("lost-season-6-…", "heroes-nbc-finale-…"). A
 * name of two words or more is distinctive enough to be taken anywhere in
 * the address, unless the address opens with some other show's name.
 */

export interface TvShow {
  /** Whatever the caller keys a show by. */
  id: string;
  name: string;
}

const TV_ARTICLE = /^https:\/\/www\.theringer\.com\/(\d{4})\/(\d{2})\/(\d{2})\/tv\/([^/]+)$/;

export function isRingerTvUrl(url: string): boolean {
  return TV_ARTICLE.test(url);
}

/** The last part of a /tv/ address, without the hex id older addresses end in. */
export function tvSlug(url: string): string | null {
  const slug = TV_ARTICLE.exec(url)?.[4];
  return slug ? slug.replace(/(-[0-9a-f]{10,14})+$/, "") : null;
}

export function publishedAtFromTvUrl(url: string): number | null {
  const m = TV_ARTICLE.exec(url);
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

/** Lower case, letters and digits, single spaces. */
function words(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** A name as one run of letters, so "E.R." and "ER" are the same name. "The" in front does not count. */
function compact(name: string): string {
  return words(name).replace(/^the /, "").replace(/ /g, "");
}

/** Words that follow a show's name in an address and mean the article is about television. */
const TV_WORDS = new Set([
  "season", "seasons", "episode", "episodes", "finale", "premiere", "recap", "review", "series", "show", "pilot",
  "reboot", "revival", "cast", "hbo", "netflix", "fx", "amc", "nbc", "abc", "cbs", "fox", "showtime", "hulu",
  "amazon", "apple", "max", "peacock", "starz", "usa", "bbc", "disney", "paramount", "exit", "power", "character",
  "characters", "ranking", "rankings", "ranked", "explained", "breakdown", "trailer", "oral",
]);

/** `S2 E22`, from "…-season-2-episode-22-…" or "…-s02e22-…". */
export function episodeFromSlug(slug: string): { season: number; episode: number } | null {
  const m = slug.match(/(?:^|-)season-(\d{1,2})-episode-(\d{1,3})(?:-|$)/) ?? slug.match(/(?:^|-)s(\d{1,2})e(\d{1,3})(?:-|$)/);
  return m ? { season: Number(m[1]), episode: Number(m[2]) } : null;
}

/**
 * The show's name as the address gives it: the words before the first one
 * that only describes the article ("fargo-season-3-episode-3-review-…" is
 * "Fargo"). Kept with an unmatched article so a person can see what it is
 * about; matching never relies on it. Null when the address opens with such
 * a word, or has none.
 */
export function guessShowTitle(slug: string): string | null {
  const parts = slug.split("-").filter(Boolean);
  const stop = parts.findIndex((p) => TV_WORDS.has(p));
  if (stop <= 0) return null;
  return parts
    .slice(0, stop)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");
}

/** Titles set in quotation marks in a headline: ‘The Curse’, 'Lost', "E.R." */
function quotedTitles(headline: string): string[] {
  const found: string[] = [];
  for (const m of headline.matchAll(/[‘“"']([^‘’“”"']{2,60})[’”"']/g)) found.push(m[1]!);
  return found;
}

/**
 * The library show an article is about, or null. The longest name wins when
 * more than one matches, so "Friday Night Lights" beats a show called
 * "Lights".
 */
export function matchShow<T extends TvShow>(slug: string, headline: string, shows: readonly T[]): T | null {
  const slugWords = slug.split("-").filter(Boolean);
  const slugText = ` ${slugWords.join(" ")} `;
  const quoted = new Set(quotedTitles(headline).map(compact));
  // When the address opens with a show of its own ("the-rehearsal-…-review-
  // hbo-nathan-for-you"), a library show named later in it is a comparison,
  // not the subject.
  const opensWith = guessShowTitle(slug);
  const opening = opensWith === null ? null : ` ${words(opensWith)} `;

  let best: T | null = null;
  for (const show of shows) {
    const name = words(show.name).replace(/^the /, "");
    if (!name) continue;
    const nameWords = name.split(" ");

    const inQuotes = quoted.has(compact(show.name));
    const inAddress =
      nameWords.length >= 2
        ? slugText.includes(` ${name} `) && (opening === null || opening.includes(` ${name} `))
        : // One word: only at the front, and only with a television word after it.
          (slugWords[0] === name && TV_WORDS.has(slugWords[1] ?? "")) ||
          (slugWords[0] === "the" && slugWords[1] === name && TV_WORDS.has(slugWords[2] ?? ""));

    if ((inQuotes || inAddress) && (!best || compact(show.name).length > compact(best.name).length)) best = show;
  }
  return best;
}

/** A list entry's title against the library's shows: the same name, and nothing looser. */
export function matchListEntry<T extends TvShow>(title: string, shows: readonly T[]): T | null {
  const wanted = compact(title);
  if (!wanted) return null;
  return shows.find((show) => compact(show.name) === wanted) ?? null;
}
