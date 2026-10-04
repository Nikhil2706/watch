/**
 * Which of The Ringer's /movies/ addresses are reviews, and which film a
 * review's address names. Pure, so it can be tested; ringer.ts does the
 * fetching.
 *
 * A review's address carries the word "review" after the film's name, and
 * that is the only marker there is — the sitemap gives addresses, nothing
 * else. It comes in two shapes:
 *
 *   /2017/04/13/movies/james-gray-the-lost-city-of-z-review-8b5bf16096e5
 *   /2019/11/08/movies/doctor-sleep-review
 *
 * The rule here used to ask for a hyphen after "review", which is only the
 * first shape. Every review whose address simply ends in "-review" was read
 * as an ordinary article instead, opened by the list scraper, found not to be
 * a list and set aside: 118 of them between 2017 and 2025 on the day this was
 * found, Miles Surrey on Doctor Sleep among them.
 *
 * "-reviews" (a round-up, an exit survey) and "-preview" stay out: neither is
 * one critic on one film.
 */

const MOVIE_ARTICLE = /^https:\/\/www\.theringer\.com\/\d{4}\/\d{2}\/\d{2}\/movies\/([^/]+)$/;
const REVIEW_SLUG = /^(.+)-review(?:-.*)?$/;

/** The address's last part ("doctor-sleep-review") when it is under /movies/, else null. */
function movieSlug(url: string): string | null {
  return MOVIE_ARTICLE.exec(url)?.[1] ?? null;
}

export function isRingerMovieUrl(url: string): boolean {
  return movieSlug(url) !== null;
}

export function isRingerReviewUrl(url: string): boolean {
  const slug = movieSlug(url);
  return slug !== null && REVIEW_SLUG.test(slug);
}

/**
 * Words an address puts between the film's name and "review" that are not
 * part of the name: "the-brutalist-movie-review", "…-netflix-movie-review".
 */
const NOT_THE_TITLE = new Set(["movie", "film", "netflix"]);

/**
 * The film a review's address names, as typed words for the matcher — which
 * is forgiving about a director's name in front ("James Gray The Lost City
 * Of Z") but not about "Movie" on the end. Null when the address is not a
 * review's.
 */
export function ringerReviewFilmTitle(url: string): string | null {
  const slug = movieSlug(url);
  const named = slug ? REVIEW_SLUG.exec(slug)?.[1] : null;
  if (!named) return null;
  const words = named.split("-").filter(Boolean);
  while (words.length > 1 && NOT_THE_TITLE.has(words[words.length - 1]!)) words.pop();
  return words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join(" ");
}
