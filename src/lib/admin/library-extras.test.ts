import assert from "node:assert/strict";
import { test } from "node:test";

import {
  fetchAllReport,
  fileName,
  folderMatchFile,
  folderMatchHeading,
  folderMatchRunReport,
  franchiseStatus,
  gapsLabel,
  kindBackfillReport,
  memberTitle,
  noScheduleMessage,
  rolloutFormFrom,
  rolloutRequest,
  seasonGaps,
  seriesLinkedReport,
  sfKindLabel,
  sfOptions,
  sfPick,
  slotStatus,
  slotsSummary,
  syncAllRounds,
  syncReport,
  toLocalInput,
} from "./library-extras.ts";

test("season gaps: only holes between episodes present, per season", () => {
  const eps = [
    { season: 1, episode: 1 },
    { season: 1, episode: 2 },
    { season: 1, episode: 5 },
    { season: 2, episode: 1 },
    { season: 2, episode: 3 },
    { season: null, episode: 9 },
    { season: 3, episode: null },
  ];
  assert.deepEqual(seasonGaps(eps), [
    { season: 1, episode: 3 },
    { season: 1, episode: 4 },
    { season: 2, episode: 2 },
  ]);
  assert.equal(gapsLabel(seasonGaps(eps)), "S1E3, S1E4, S2E2");
  assert.equal(gapsLabel([{ season: 0, episode: 4 }]), "episode 4");
  assert.deepEqual(seasonGaps([{ season: 1, episode: 7 }]), []); // nothing local says what's beyond
});

test("an episode shows its own label, and what it's wrongly tagged as", () => {
  assert.deepEqual(memberTitle({ label: "Episode 7: Angel", name: "Angel (1999)" }), { primary: "Episode 7: Angel", taggedAs: "Angel (1999)" });
  assert.deepEqual(memberTitle({ label: null, name: "Behind the Scenes" }), { primary: "Behind the Scenes", taggedAs: null });
  assert.deepEqual(memberTitle({ label: "Episode 7", name: "Episode 7" }), { primary: "Episode 7", taggedAs: null });
  assert.equal(fileName("/media/Buffy/Season 1/x.mp4"), "x.mp4");
});

test("show settings messages", () => {
  assert.equal(fetchAllReport(20, 0), "Fetched 20.");
  assert.equal(fetchAllReport(18, 2), "Fetched 18, 2 could not be found on OMDb — those keep their current titles.");
  assert.equal(
    seriesLinkedReport({ seriesName: "Buffy the Vampire Slayer", posterFound: true, kind: "series" }),
    "Series linked — Buffy the Vampire Slayer. Poster found for Browse and the collection page. OMDb calls this a TV series — tiles will say episodes.",
  );
  assert.equal(seriesLinkedReport(null), "Series linked. Fetch OMDb is ready for each episode.");
  assert.equal(kindBackfillReport({ checked: 0 }), "Every linked show already has a kind.");
  assert.equal(kindBackfillReport({ checked: 5, resolved: 4, unresolved: 1 }), "4 of 5 resolved — 1 OMDb had no answer for; set those by hand in Show settings.");
});

test("release schedule: form from a plan, and back to a request", () => {
  const start = new Date(2026, 9, 14, 9, 5).getTime();
  assert.equal(toLocalInput(start), "2026-10-14T09:05");
  const blank = rolloutFormFrom(null, [], start);
  assert.deepEqual(blank, { mode: "immediate", perRelease: "1", weekday: "0", timeOfDay: "09:00", start: "2026-10-14T09:05", total: "" });
  assert.deepEqual(rolloutRequest("group", "g1", blank, start), { ok: false, error: "Enter the total number expected." });

  const plan = { mode: "weekly" as const, perRelease: 2, weekday: 5, timeOfDay: "20:00", startAt: start };
  const slots = [1, 2, 3].map((i) => ({ slotIndex: i, releaseAt: start + i, revealedAt: i === 1 ? start : null }));
  const form = rolloutFormFrom(plan, slots, 0);
  assert.deepEqual(form, { mode: "weekly", perRelease: "2", weekday: "5", timeOfDay: "20:00", start: "2026-10-14T09:05", total: "3" });
  assert.deepEqual(rolloutRequest("series", "s1", form, 0), {
    ok: true,
    body: { subjectType: "series", subjectId: "s1", mode: "weekly", perRelease: 2, weekday: 5, timeOfDay: "20:00", startAt: start, expectedTotal: 3 },
  });
  assert.equal(slotsSummary(slots), "1 of 3 revealed, 2 pending");
  assert.equal(slotStatus(slots[0]!, start), "revealed");
  assert.equal(slotStatus({ releaseAt: 10, revealedAt: null }, 20), "due");
  assert.equal(slotStatus({ releaseAt: 30, revealedAt: null }, 20), "scheduled");
  assert.match(noScheduleMessage("group"), /every confirmed episode/);
  assert.match(noScheduleMessage("series"), /every owned film/);
});

test("franchises: status line and the TMDB sync rounds", async () => {
  assert.equal(franchiseStatus({ id: "1", name: "Alien", entryCount: 4, matchedCount: 4, source: "tmdb" }), "Complete — all 4 here");
  assert.equal(franchiseStatus({ id: "2", name: "X", entryCount: 3, matchedCount: 1, source: "manual" }), "1 of 3 here · made by hand");
  const rounds = [
    { created: 3, updated: 1, removed: 0, collections: 40, done: false },
    { created: 2, updated: 0, removed: 1, collections: 42, done: true },
  ];
  let i = 0;
  const total = await syncAllRounds(async () => rounds[i++]!);
  assert.deepEqual(total, { created: 5, updated: 1, removed: 1, collections: 42, done: true, rounds: 2 });
  assert.equal(syncReport(total), "42 franchises from TMDB — 5 new, 1 refreshed, 1 no longer in the library.");
  let calls = 0;
  const capped = await syncAllRounds(async () => (calls++, { created: 0, updated: 0, removed: 0, collections: 1, done: false }));
  assert.equal(capped.rounds, 10);
  assert.equal(calls, 10);
  assert.equal(syncReport(capped), "1 franchises from TMDB — 0 new, 0 refreshed. More to fetch: run it again.");
});

test("special-feature picker", () => {
  const targets = { films: [{ id: "f1", label: "Heat (1995)" }], directors: [{ id: "d1", label: "Michael Mann" }] };
  assert.equal(sfKindLabel("director"), "Director");
  assert.equal(sfKindLabel("weird"), "weird");
  assert.deepEqual(sfOptions(targets, "director"), [{ id: "d1", label: "Michael Mann" }]);
  assert.deepEqual(sfOptions(targets, "actor"), []);
  assert.deepEqual(sfOptions(null, "film"), []);
  assert.deepEqual(sfPick(sfOptions(targets, "film"), "Heat (1995)"), { id: "f1", label: "Heat (1995)" });
  assert.equal(sfPick(sfOptions(targets, "film"), "Heat"), null);
});

test("match from folders", () => {
  assert.equal(folderMatchFile("/media/Steven Spielberg/Amblin.mp4"), "Steven Spielberg/Amblin.mp4");
  assert.equal(folderMatchHeading(1, 0), "1 file the folders suggest a match for");
  assert.equal(folderMatchHeading(0, 3), "Matched from their folders");
  assert.equal(folderMatchHeading(0, 0), "");
  assert.equal(folderMatchRunReport({ looked: 12, applied: 3, suggested: 2, failed: 1 }), "12 unidentified files: 3 matched from their folders, 2 to confirm, 1 could not be applied.");
  assert.equal(folderMatchRunReport({ looked: 1 }), "1 unidentified file: 0 matched from their folders, 0 to confirm.");
});
