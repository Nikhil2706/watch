import assert from "node:assert/strict";
import { test } from "node:test";

import { friendsFeed, maySeeActivity, parseVisibility, reviewSnippet, stars, takesLine } from "./friends-feed.ts";

test("friends see each other's activity; nobody sees their own; 'nobody' hides it", () => {
  const base = { viewerId: "a", ownerId: "b", ownerVisibility: "friends" as const, friends: true };
  assert.equal(maySeeActivity(base), true);
  assert.equal(maySeeActivity({ ...base, ownerId: "a" }), false);
  assert.equal(maySeeActivity({ ...base, ownerVisibility: "nobody" }), false);
  assert.equal(maySeeActivity({ ...base, friends: false }), false);
});

test("an unknown visibility is read as friends, the default", () => {
  assert.equal(parseVisibility("nobody"), "nobody");
  assert.equal(parseVisibility("friends"), "friends");
  assert.equal(parseVisibility(undefined), "friends");
  assert.equal(parseVisibility("everyone"), "friends");
});

test("one card per film, newest first; each friend's watch, rating and review together", () => {
  const cards = friendsFeed(
    [
      { kind: "watched", userId: "r", username: "rewati", filmKey: "past-lives", at: 100 },
      { kind: "rated", userId: "r", username: "rewati", filmKey: "past-lives", at: 110, score: 9 },
      { kind: "reviewed", userId: "r", username: "rewati", filmKey: "past-lives", at: 120, text: "Wrecked me." },
      { kind: "watched", userId: "a", username: "abhigyan", filmKey: "past-lives", at: 50 },
      { kind: "watched", userId: "a", username: "abhigyan", filmKey: "arrival", at: 200 },
    ],
    10,
  );
  assert.deepEqual(
    cards.map((c) => [c.filmKey, c.at, c.takes.map((t) => t.username)]),
    [
      ["arrival", 200, ["abhigyan"]],
      ["past-lives", 120, ["rewati", "abhigyan"]],
    ],
  );
  assert.deepEqual(cards[1]!.takes[0], {
    userId: "r",
    username: "rewati",
    at: 120,
    watched: true,
    score: 9,
    review: "Wrecked me.",
  });
});

test("the latest review wins, whatever order they arrive in", () => {
  const [card] = friendsFeed(
    [
      { kind: "reviewed", userId: "r", username: "rewati", filmKey: "f", at: 300, text: "second thoughts" },
      { kind: "reviewed", userId: "r", username: "rewati", filmKey: "f", at: 100, text: "first" },
    ],
    1,
  );
  assert.equal(card!.takes[0]!.review, "second thoughts");
});

test("limit keeps the newest films", () => {
  const events = [1, 2, 3].map((n) => ({ kind: "watched" as const, userId: "u", username: "u", filmKey: `f${n}`, at: n }));
  assert.deepEqual(friendsFeed(events, 2).map((c) => c.filmKey), ["f3", "f2"]);
});

test("the card's line: stars when rated, and how many more friends", () => {
  assert.equal(stars(10), "★★★★★");
  assert.equal(stars(7), "★★★½");
  assert.equal(stars(1), "½");
  const take = (username: string, score: number | null) => ({ userId: username, username, at: 0, watched: true, score, review: null });
  assert.equal(takesLine([take("rewati", 8)]), "rewati ★★★★");
  assert.equal(takesLine([take("rewati", null), take("abhigyan", 6)]), "rewati +1");
});

test("a review's snippet is one line, quoted, cut with an ellipsis", () => {
  assert.equal(reviewSnippet("  Wrecked\n me. "), "“Wrecked me.”");
  assert.equal(reviewSnippet("x".repeat(100), 10), `“${"x".repeat(9)}…”`);
});
