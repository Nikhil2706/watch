import { test } from "node:test";
import assert from "node:assert/strict";

import { auditHead, groupsHead, linkQuestion, oldestReport, se, stillsHead, stillsLists, storeCards, tickReport, tmdbAge } from "./tmdb-view.ts";

const NOW = Date.UTC(2026, 9, 15);

test("ages and episode codes", () => {
  assert.equal(tmdbAge(0), "today");
  assert.equal(tmdbAge(1), "1 day");
  assert.equal(tmdbAge(null), "—");
  assert.equal(se({ season: 1, episode: 2 }), "S01E02");
});

test("store cards", () => {
  const cards = storeCards({ movies: 1500, oldestFetch: NOW - 40 * 86400000 }, { people: 9000, photoCache: { count: 10, megabytes: 3 } }, NOW);
  assert.deepEqual(
    cards.map((c) => [c.label, c.value]),
    [
      ["Films cached", "1500"],
      ["Oldest entry", "40 days"],
      ["People", "9000"],
      ["Credits", "—"],
      ["Photos cached", "10"],
    ],
  );
});

test("reports", () => {
  assert.equal(tickReport({ moviesFetched: 3, done: false }), "Fetched 3 films, 0 seasons, linked 0 shows, 0 failures — press again to continue.");
  assert.match(oldestReport({ refreshed: 5, remaining: 0 }), /0 still over 30 days\.$/);
  assert.equal(auditHead({ audited: 10, suspect: 1, check: 2, uncached: 3, confirmed: 4, findings: [] }), "10 audited · 1 suspect · 2 worth a look · 3 not cached, so not judged · 4 confirmed by hand, not re-judged");
});

test("groups and the link question", () => {
  const groups = [
    { groupId: "a", name: "Lost", files: 120, kind: "series", link: { tmdbId: 1, name: "Lost", resolvedBy: "auto" } },
    { groupId: "b", name: "Out 1", files: 8, kind: "movie", link: null },
    { groupId: "c", name: "Heroes", files: 34, kind: null, link: null },
  ];
  assert.equal(groupsHead(groups), "3 groups · 1 linked · 1 shows not linked · 1 films in parts, correctly not linked");
  assert.match(linkQuestion(groups[2]!, { name: "Heroes", episodes: 77 }), /\(34 files\) to TMDB's "Heroes" \(77 episodes\)/);
});

test("stills plan lists only what has entries", () => {
  const d = { alreadyDone: 5, planned: 2, skipped: { unparsed: 1 }, details: { unparsed: ["/media/x/ep.mkv"], noEpisode: [], noStill: [] } };
  assert.match(stillsHead(d), /^5 already carry TMDB's still · 2 ready to apply · 1 with no episode number/);
  assert.deepEqual(stillsLists(d).map((l) => l.title), ["No season or episode in the filename"]);
  assert.equal(stillsLists({}).length, 0);
});
