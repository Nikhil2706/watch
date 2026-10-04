import assert from "node:assert/strict";
import { test } from "node:test";

import { isRingerMovieUrl, isRingerReviewUrl, ringerReviewFilmTitle } from "./ringer-urls.ts";

const R = "https://www.theringer.com";

test("a review with more words after 'review' is a review, as before", () => {
  const url = `${R}/2017/04/13/movies/james-gray-the-lost-city-of-z-review-8b5bf16096e5`;
  assert.equal(isRingerReviewUrl(url), true);
  assert.equal(ringerReviewFilmTitle(url), "James Gray The Lost City Of Z");
});

test("a review whose address ends in 'review' is a review too", () => {
  const url = `${R}/2019/11/08/movies/doctor-sleep-review`;
  assert.equal(isRingerReviewUrl(url), true);
  assert.equal(ringerReviewFilmTitle(url), "Doctor Sleep");
});

test("'movie', 'film' and 'netflix' before 'review' are not part of the title", () => {
  assert.equal(ringerReviewFilmTitle(`${R}/2024/12/18/movies/the-brutalist-movie-review`), "The Brutalist");
  assert.equal(
    ringerReviewFilmTitle(`${R}/2024/05/10/movies/kingdom-of-the-planet-of-the-apes-film-review`),
    "Kingdom Of The Planet Of The Apes",
  );
  assert.equal(
    ringerReviewFilmTitle(`${R}/2025/10/22/movies/house-of-dynamite-netflix-movie-review`),
    "House Of Dynamite",
  );
});

test("a film called Movie keeps its name", () => {
  assert.equal(ringerReviewFilmTitle(`${R}/2020/01/01/movies/movie-review`), "Movie");
});

test("round-ups and previews are articles, not reviews", () => {
  for (const slug of [
    "gladiator-ii-reviews-exit-survey-denzel-washington-paul-mescal",
    "zack-snyders-justice-league-snyder-cut-reviews",
    "wuthering-heights-movie-preview-hate-watch",
    "tiff-preview-joker-uncut-gems-green-book",
    "decisions-reviewed-will-smith-mel-gibson-narcos-d0dde42ad50a",
  ]) {
    const url = `${R}/2021/01/15/movies/${slug}`;
    assert.equal(isRingerMovieUrl(url), true, slug);
    assert.equal(isRingerReviewUrl(url), false, slug);
    assert.equal(ringerReviewFilmTitle(url), null, slug);
  }
});

test("only /movies/ addresses count", () => {
  assert.equal(isRingerReviewUrl(`${R}/2019/11/08/tv/watchmen-review`), false);
  assert.equal(isRingerMovieUrl(`${R}/2019/11/08/tv/watchmen-review`), false);
  assert.equal(isRingerMovieUrl(`${R}/2019/11/08/movies/a/b`), false);
});
