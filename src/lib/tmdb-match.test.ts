import assert from "node:assert/strict";
import { test } from "node:test";

import {
  countFit,
  normaliseShowName,
  pickBestShowMatch,
  scoreShowCandidate,
  type ShowCandidate,
} from "./tmdb-match.ts";

/**
 * The three wrong matches this exists to prevent are real: taking TMDB's first
 * search result linked E.R. (308 files) to Trauma: Life in the E.R. (75
 * episodes), The Curse (10 files) to The Curse of Oak Island (258), and
 * Parallel (4 files) to Parallel Me (8). Each is asserted below.
 */

const show = (name: string, episodeCount: number | null, id = 1): ShowCandidate => ({
  id,
  name,
  episodeCount,
  firstAirYear: null,
});

test("names normalise past punctuation and articles", () => {
  assert.equal(normaliseShowName("E.R."), "er");
  assert.equal(normaliseShowName("ER"), "er");
  assert.equal(normaliseShowName("The West Wing"), "west wing");
  assert.equal(normaliseShowName("the  west   wing"), "west wing");
});

test("countFit is 1 when the counts line up", () => {
  assert.equal(countFit(154, 154), 1);
  assert.equal(countFit(10, 10), 1);
});

test("countFit tolerates an incomplete library", () => {
  assert.equal(countFit(119, 118), 1, "one extra file is nothing");
  assert.equal(countFit(45, 46), 1, "holding one fewer than the show has is normal");
  assert.equal(countFit(12, 22), 1, "half a season is still that season");
});

test("countFit collapses when we hold far more files than the show has episodes", () => {
  assert.ok(countFit(308, 75) < 0.1, "308 files is not a 75-episode show");
  assert.equal(countFit(308, 75) >= 0, true);
});

test("countFit collapses when the show is vastly longer than what we hold", () => {
  assert.ok(countFit(10, 258) < 0.1, "10 files is not a 258-episode show");
});

test("an unknown episode count is neutral, not disqualifying", () => {
  assert.equal(countFit(10, null), 0.5);
});

/* ---- the three real failures ---- */

test("E.R. does not match Trauma: Life in the E.R.", () => {
  const best = pickBestShowMatch([show("Trauma: Life in the E.R.", 75)], { name: "E.R.", fileCount: 308 });
  assert.equal(best, null, "a 75-episode show cannot hold 308 files");
});

test("E.R. does match the real ER", () => {
  const best = pickBestShowMatch([show("ER", 331)], { name: "E.R.", fileCount: 308 });
  assert.ok(best, "331 episodes, 308 files, same name once normalised");
  assert.equal(best!.candidate.name, "ER");
});

test("The Curse does not match The Curse of Oak Island", () => {
  const best = pickBestShowMatch([show("The Curse of Oak Island", 258)], { name: "The Curse", fileCount: 10 });
  assert.equal(best, null, "a shared prefix is not a match");
});

test("The Curse does match the real one when it is offered", () => {
  const best = pickBestShowMatch(
    [show("The Curse of Oak Island", 258, 1), show("The Curse", 10, 2)],
    { name: "The Curse", fileCount: 10 },
  );
  assert.ok(best);
  assert.equal(best!.candidate.id, 2, "the exact name with the right count must win");
});

test("Parallel does not match Parallel Me", () => {
  const best = pickBestShowMatch([show("Parallel Me", 8)], { name: "Parallel", fileCount: 4 });
  assert.equal(best, null);
});

/* ---- the ones that were right stay right ---- */

test("the correct matches from the real run all still pass", () => {
  const cases: Array<[string, number, string, number]> = [
    ["The West Wing", 154, "The West Wing", 154],
    ["Sports Night", 46, "Sports Night", 45],
    ["Lost", 119, "Lost", 118],
    ["Pixar Popcorn", 10, "Pixar Popcorn", 10],
    ["Forky Asks a Question", 10, "Forky Asks a Question", 10],
    ["The Little Drummer Girl", 6, "The Little Drummer Girl", 6],
    ["The Age of the Medici", 3, "The Age of the Medici", 3],
  ];
  for (const [group, files, name, episodes] of cases) {
    const best = pickBestShowMatch([show(name, episodes)], { name: group, fileCount: files });
    assert.ok(best, `${group} should still match ${name}`);
  }
});

test("a better candidate beats a worse one rather than order deciding it", () => {
  const best = pickBestShowMatch(
    [show("Lost in Translation", 1, 9), show("Lost", 118, 4)],
    { name: "Lost", fileCount: 119 },
  );
  assert.equal(best!.candidate.id, 4);
});

test("no candidates means no match", () => {
  assert.equal(pickBestShowMatch([], { name: "Anything", fileCount: 5 }), null);
});

test("a translated title does not auto-link, and that is the accepted cost", () => {
  // Correct in fact, but the names do not match once normalised. Left for a
  // human rather than guessed at — see MIN_COUNT_FIT_TO_ACT.
  assert.equal(
    pickBestShowMatch([show("Acts of the Apostles", 5)], { name: "Atti Degli Apostoli", fileCount: 4 }),
    null,
  );
});

test("a prefix match can never authorise acting on its own", () => {
  // Even with a perfect-looking count, "Parallel" is not "Parallel Me".
  assert.equal(pickBestShowMatch([show("Parallel Me", 4)], { name: "Parallel", fileCount: 4 }), null);
});

test("the reason is stated, so an unlinked group can be explained", () => {
  const m = scoreShowCandidate(show("Trauma: Life in the E.R.", 75), { name: "E.R.", fileCount: 308 });
  assert.match(m.why, /308 files vs 75 episodes/);
  assert.equal(m.confident, false);
});
