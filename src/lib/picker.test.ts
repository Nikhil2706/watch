import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyColdStart,
  buildTasteProfile,
  pickSlate,
  scoreCandidates,
  seededRandom,
  type PickCandidate,
  type TasteSignals,
} from "./picker.ts";

function candidate(over: Partial<PickCandidate> & { id: string }): PickCandidate {
  return {
    title: over.id,
    year: 1970,
    genres: [],
    directors: [],
    actors: [],
    popularity: 6,
    seen: false,
    href: `/item/${over.id}`,
    isGroup: false,
    articleCount: 0,
    ...over,
  };
}

const noSignals: TasteSignals = {
  likedIds: new Set(),
  ratings: new Map(),
  playedIds: new Set(),
  abandonedIds: new Set(),
};

test("an empty profile is marked cold", () => {
  const profile = buildTasteProfile([candidate({ id: "a" })], noSignals);
  assert.equal(profile.isCold, true);
});

test("a favourite teaches genre, director and decade", () => {
  const cands = [candidate({ id: "a", genres: ["Noir"], directors: ["Bava"], year: 1964 })];
  const profile = buildTasteProfile(cands, { ...noSignals, likedIds: new Set(["a"]) });
  assert.equal(profile.isCold, false);
  assert.ok((profile.genres.get("Noir") ?? 0) > 0);
  assert.ok((profile.directors.get("Bava") ?? 0) > 0);
  assert.ok((profile.decades.get(1960) ?? 0) > 0);
});

test("a low rating makes an item a negative", () => {
  const cands = [candidate({ id: "a" })];
  const profile = buildTasteProfile(cands, { ...noSignals, ratings: new Map([["a", 3]]) });
  assert.ok(profile.negatives.has("a"));
});

test("an abandoned title is a negative", () => {
  const profile = buildTasteProfile([candidate({ id: "a" })], {
    ...noSignals,
    abandonedIds: new Set(["a"]),
  });
  assert.ok(profile.negatives.has("a"));
});

test("a shared director outscores an unrelated film", () => {
  const cands = [
    candidate({ id: "liked", directors: ["Bava"], genres: ["Horror"] }),
    candidate({ id: "same-director", directors: ["Bava"], genres: ["Horror"] }),
    candidate({ id: "unrelated", directors: ["Ozu"], genres: ["Drama"] }),
  ];
  const profile = buildTasteProfile(cands, { ...noSignals, likedIds: new Set(["liked"]) });
  const scored = scoreCandidates(cands, profile);
  const byId = new Map(scored.map((s) => [s.candidate.id, s]));
  assert.ok(byId.get("same-director")!.score > byId.get("unrelated")!.score);
});

test("the reason names the director when that is what matched", () => {
  const cands = [
    candidate({ id: "liked", directors: ["Bava"] }),
    candidate({ id: "other", directors: ["Bava"] }),
  ];
  const profile = buildTasteProfile(cands, { ...noSignals, likedIds: new Set(["liked"]) });
  const scored = scoreCandidates(cands, profile);
  const other = scored.find((s) => s.candidate.id === "other")!;
  assert.match(other.reason, /Bava/);
});

test("a negative is pushed below an ordinary candidate", () => {
  const cands = [candidate({ id: "bad" }), candidate({ id: "fine" })];
  const profile = buildTasteProfile(cands, { ...noSignals, ratings: new Map([["bad", 2]]) });
  const scored = scoreCandidates(cands, profile);
  const byId = new Map(scored.map((s) => [s.candidate.id, s]));
  assert.ok(byId.get("bad")!.score < byId.get("fine")!.score);
});

test("the curator's writing is a real signal on a cold profile", () => {
  const cands = [
    candidate({ id: "written-about", articleCount: 12 }),
    candidate({ id: "silent", articleCount: 0 }),
  ];
  const profile = buildTasteProfile(cands, noSignals);
  const scored = scoreCandidates(cands, profile);
  const byId = new Map(scored.map((s) => [s.candidate.id, s]));
  assert.ok(
    byId.get("written-about")!.score > byId.get("silent")!.score,
    "with no taste signal at all, what he wrote about should carry the pick",
  );
});

test("the same seed produces the same slate", () => {
  const cands = Array.from({ length: 40 }, (_, i) => candidate({ id: `c${i}`, popularity: 5 + (i % 5) }));
  const profile = buildTasteProfile(cands, noSignals);
  const scored = scoreCandidates(cands, profile);
  const a = pickSlate(scored, { seed: 42 }).map((s) => s.candidate.id);
  const b = pickSlate(scored, { seed: 42 }).map((s) => s.candidate.id);
  assert.deepEqual(a, b);
});

test("different seeds produce different slates — the whole point of re-rolling", () => {
  const cands = Array.from({ length: 40 }, (_, i) => candidate({ id: `c${i}`, popularity: 5 + (i % 5) }));
  const profile = buildTasteProfile(cands, noSignals);
  const scored = scoreCandidates(cands, profile);
  const a = pickSlate(scored, { seed: 1 }).map((s) => s.candidate.id);
  const b = pickSlate(scored, { seed: 9999 }).map((s) => s.candidate.id);
  assert.notDeepEqual(a, b);
});

test("a slate never repeats a candidate", () => {
  const cands = Array.from({ length: 30 }, (_, i) => candidate({ id: `c${i}` }));
  const scored = scoreCandidates(cands, buildTasteProfile(cands, noSignals));
  const slate = pickSlate(scored, { seed: 7, size: 10 });
  assert.equal(new Set(slate.map((s) => s.candidate.id)).size, slate.length);
});

test("excluded ids never appear — this is what makes a re-roll a re-roll", () => {
  const cands = Array.from({ length: 20 }, (_, i) => candidate({ id: `c${i}` }));
  const scored = scoreCandidates(cands, buildTasteProfile(cands, noSignals));
  const exclude = new Set(["c0", "c1", "c2", "c3", "c4"]);
  const slate = pickSlate(scored, { seed: 3, size: 10, exclude });
  for (const s of slate) assert.ok(!exclude.has(s.candidate.id));
});

test("one candidate is returned without pretending to shuffle", () => {
  const cands = [candidate({ id: "only" })];
  const scored = scoreCandidates(cands, buildTasteProfile(cands, noSignals));
  const slate = pickSlate(scored, { seed: 1, size: 10 });
  assert.equal(slate.length, 1);
  assert.equal(slate[0]!.candidate.id, "only");
});

test("an exhausted pool returns nothing rather than throwing", () => {
  const cands = [candidate({ id: "a" })];
  const scored = scoreCandidates(cands, buildTasteProfile(cands, noSignals));
  assert.deepEqual(pickSlate(scored, { seed: 1, exclude: new Set(["a"]) }), []);
});

test("an empty candidate list returns an empty slate", () => {
  assert.deepEqual(pickSlate([], { seed: 1 }), []);
});

test("cold start replaces taste reasons with an honest line", () => {
  const cands = [candidate({ id: "a" })];
  const profile = buildTasteProfile(cands, noSignals);
  const picks = applyColdStart(scoreCandidates(cands, profile), profile);
  assert.match(picks[0]!.reason, /have not watched anything here yet/);
});

test("cold start still credits the curator where there is writing", () => {
  const cands = [candidate({ id: "a", articleCount: 4 })];
  const profile = buildTasteProfile(cands, noSignals);
  const picks = applyColdStart(scoreCandidates(cands, profile), profile);
  assert.match(picks[0]!.reason, /written about/);
});

test("a warm profile keeps its real reasons", () => {
  const cands = [
    candidate({ id: "liked", directors: ["Bava"] }),
    candidate({ id: "other", directors: ["Bava"] }),
  ];
  const profile = buildTasteProfile(cands, { ...noSignals, likedIds: new Set(["liked"]) });
  const picks = applyColdStart(scoreCandidates(cands, profile), profile);
  assert.ok(picks.every((p) => !p.reason.includes("have not watched anything")));
});

test("the seeded rng is deterministic and stays in range", () => {
  const a = seededRandom(5);
  const b = seededRandom(5);
  for (let i = 0; i < 200; i += 1) {
    const v = a();
    assert.equal(v, b());
    assert.ok(v >= 0 && v < 1);
  }
});

test("scores stay finite when a penalty applies to every candidate", () => {
  const cands = [candidate({ id: "a" }), candidate({ id: "b" })];
  const profile = buildTasteProfile(cands, {
    ...noSignals,
    ratings: new Map([["a", 1], ["b", 1]]),
  });
  const scored = scoreCandidates(cands, profile);
  for (const s of scored) assert.ok(Number.isFinite(s.score));
  // Softmax over uniformly negative scores must still return a slate.
  assert.equal(pickSlate(scored, { seed: 2, size: 2 }).length, 2);
});
