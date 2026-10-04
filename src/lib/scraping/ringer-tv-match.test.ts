import assert from "node:assert/strict";
import { test } from "node:test";

import {
  episodeFromSlug,
  guessShowTitle,
  isRingerTvUrl,
  matchListEntry,
  matchShow,
  publishedAtFromTvUrl,
  tvSlug,
} from "./ringer-tv-match.ts";

const R = "https://www.theringer.com";
const SHOWS = [
  { id: "er", name: "E.R." },
  { id: "ww", name: "The West Wing" },
  { id: "lost", name: "Lost" },
  { id: "fnl", name: "Friday Night Lights" },
  { id: "heroes", name: "Heroes" },
  { id: "curse", name: "The Curse" },
  { id: "nathan", name: "Nathan For You" },
];

test("only /tv/ addresses, and the hex id comes off the slug", () => {
  assert.equal(isRingerTvUrl(`${R}/2023/11/10/tv/the-curse-showtime-review-nathan-fielder-emma-stone-hgtv`), true);
  assert.equal(isRingerTvUrl(`${R}/2019/11/08/movies/doctor-sleep-review`), false);
  assert.equal(tvSlug(`${R}/2016/10/17/tv/westworld-season-1-episode-3-the-stray-31ff1679c94c`), "westworld-season-1-episode-3-the-stray");
  assert.equal(tvSlug(`${R}/2017/03/23/tv/legion-fx-season-1-episode-7-a6828b6794f8-a6828b6794f8`), "legion-fx-season-1-episode-7");
  assert.equal(publishedAtFromTvUrl(`${R}/2023/11/10/tv/x`), Date.UTC(2023, 10, 10));
});

test("an episode is read from the address", () => {
  assert.deepEqual(episodeFromSlug("fargo-season-3-episode-3-review-law-of-non-contradiction"), { season: 3, episode: 3 });
  assert.deepEqual(episodeFromSlug("lost-s06e17-the-end"), { season: 6, episode: 17 });
  assert.equal(episodeFromSlug("the-curse-finale-explained"), null);
});

test("the address's own guess at the show", () => {
  assert.equal(guessShowTitle("fargo-season-3-episode-3-review"), "Fargo");
  assert.equal(guessShowTitle("the-young-pope-character-power-rankings"), "The Young Pope");
  assert.equal(guessShowTitle("ranking-the-most-insufferable-yuppies-on-tv"), null);
});

test("a name of several words counts at the front of the address or the end", () => {
  assert.equal(matchShow("friday-night-lights-tv-show-anniversary-20-years", "The Gospel of Buddy Garrity", SHOWS)?.id, "fnl");
  assert.equal(matchShow("how-old-is-tim-riggins-friday-night-lights", "A Question of Age", SHOWS)?.id, "fnl");
  // In the middle it is one name among several.
  assert.equal(matchShow("writers-strike-2007-friday-night-lights-gossip-girl-heroes", "What TV Loses", SHOWS), null);
  assert.equal(matchShow("why-friday-night-lights-still-matters", "Clear Eyes", SHOWS), null);
  // Unless the headline says it is the subject.
  assert.equal(matchShow("why-friday-night-lights-still-matters", "Why ‘Friday Night Lights’ Still Matters", SHOWS)?.id, "fnl");
  assert.equal(matchShow("the-west-wing-reunion-hbo-max", "A Reunion", SHOWS)?.id, "ww");
  assert.equal(matchShow("the-curse-finale-explained-meaning-theories", "What Happened?", SHOWS)?.id, "curse");
});

test("a library show named after another show's name is a comparison, not the subject", () => {
  assert.equal(matchShow("the-rehearsal-nathan-fielder-review-hbo-nathan-for-you", "Dress Rehearsal", SHOWS), null);
  assert.equal(matchShow("actor-recap-podcasts-sopranos-scrubs-office-west-wing", "Rewatch Nation", SHOWS), null);
  // Unless the headline says so itself.
  assert.equal(
    matchShow("the-rehearsal-nathan-fielder-review-hbo-nathan-for-you", "What ‘Nathan for You’ Was Building To", SHOWS)?.id,
    "nathan",
  );
  // The show's own name opening the address is still the subject.
  assert.equal(matchShow("nathan-for-you-season-4-finale-finding-frances", "Finding Frances", SHOWS)?.id, "nathan");
  assert.equal(matchShow("friday-night-lights-tim-riggins-best-moment", "Texas Forever", SHOWS)?.id, "fnl");
});

test("a one-word name needs the front of the address and a television word after it", () => {
  assert.equal(matchShow("lost-finale-ten-years-later", "The End", SHOWS)?.id, "lost");
  assert.equal(matchShow("heroes-nbc-reboot", "Save the Cheerleader", SHOWS)?.id, "heroes");
  // The word, not the show.
  assert.equal(matchShow("lost-in-space-netflix-review", "Danger, Will Robinson", SHOWS), null);
  assert.equal(matchShow("the-lost-art-of-the-tv-theme-song", "Where Did They Go?", SHOWS), null);
  assert.equal(matchShow("superheroes-are-everywhere", "Capes", SHOWS), null);
  // "er" is inside half the words in the language.
  assert.equal(matchShow("better-call-saul-season-4-premiere", "Jimmy", SHOWS), null);
});

test("a title in the headline's quotation marks counts, whatever the address says", () => {
  assert.equal(matchShow("the-island-is-still-calling", "Ten Years On, ‘Lost’ Still Has Us", SHOWS)?.id, "lost");
  assert.equal(matchShow("county-general-forever", "‘ER’ Was the Last Great Hospital Show", SHOWS)?.id, "er");
  assert.equal(matchShow("something-else", "‘Lost in Space’ Finds Itself", SHOWS), null);
});

test("a show quoted second is a comparison unless the address names it too", () => {
  assert.equal(
    matchShow(
      "winning-time-hbo-lakers-review",
      "‘Winning Time’ Looks Like ‘Friday Night Lights’ and Acts Like ‘The Crown’",
      SHOWS,
    ),
    null,
  );
  assert.equal(matchShow("lost-at-twenty", "‘We Have to Go Back’: ‘Lost’ at Twenty", SHOWS)?.id, "lost");
  assert.equal(matchShow("the-island-at-twenty", "‘We Have to Go Back’: ‘Lost’ at Twenty", SHOWS), null);
});

test("the longer name wins", () => {
  const shows = [...SHOWS, { id: "lights", name: "Lights" }];
  assert.equal(matchShow("friday-night-lights-season-1-review", "‘Friday Night Lights’", shows)?.id, "fnl");
});

test("a list entry matches a show by its whole name only", () => {
  assert.equal(matchListEntry("The West Wing", SHOWS)?.id, "ww");
  assert.equal(matchListEntry("ER", SHOWS)?.id, "er");
  assert.equal(matchListEntry("Lost in Space", SHOWS), null);
  assert.equal(matchListEntry("", SHOWS), null);
});
