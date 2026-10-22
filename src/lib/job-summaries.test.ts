import assert from "node:assert/strict";
import { test } from "node:test";

import { tmdbRefreshSummary } from "./job-summaries.ts";

const none = { moviesFetched: 0, showsLinked: 0, seasonsFetched: 0, failures: 0, noMatch: 0, unmatched: [] };
const noStills = { applied: 0, failed: 0, unresolved: 0 };

test("a quiet week is one short line", () => {
  assert.equal(tmdbRefreshSummary(239, none, noStills), "239 refreshed · no new titles");
});

test("names what was found, in words", () => {
  const added = { ...none, moviesFetched: 3, showsLinked: 1, seasonsFetched: 2, noMatch: 4, unmatched: [{}, {}] };
  assert.equal(
    tmdbRefreshSummary(0, added, { applied: 19, failed: 0, unresolved: 0 }),
    "0 refreshed · new: 3 films, 1 show, 2 seasons · 4 not on TMDB · 2 left unmatched · 19 episode stills",
  );
});

test("failures are said, singular when there is one", () => {
  assert.equal(
    tmdbRefreshSummary(5, { ...none, failures: 1 }, { applied: 0, failed: 2, unresolved: 0 }),
    "5 refreshed · no new titles · 1 failed request · 2 stills failed",
  );
});

test("never JSON", () => {
  const line = tmdbRefreshSummary(1, { ...none, unmatched: [{ group: "Jean", files: 3 }] }, noStills);
  assert.doesNotMatch(line, /[{}"]/);
});
