import assert from "node:assert/strict";
import { test } from "node:test";

import {
  extractSubject,
  guess,
  normaliseTitle,
  proposeTargets,
  scoreCandidate,
  type KnownThings,
} from "./special-feature-guess.ts";

const known: KnownThings = {
  films: [
    { id: "film-alien", title: "Alien" },
    { id: "film-blade", title: "Blade Runner" },
    { id: "film-thething", title: "The Thing" },
  ],
  groups: [{ id: "group-alien", name: "Alien" }],
  people: [
    { id: "p-scott", name: "Ridley Scott", kind: "director" },
    { id: "p-hitch", name: "Alfred Hitchcock", kind: "director" },
    { id: "p-weaver", name: "Sigourney Weaver", kind: "actor" },
    { id: "p-cher", name: "Cher", kind: "actor" },
  ],
};

const candidate = (title: string, overview: string | null = null) => ({
  itemId: "cand",
  title,
  year: null,
  overview,
});

test("a title saying making-of scores highly", () => {
  const { confidence, reasons } = scoreCandidate(candidate("The Making of Alien"));
  assert.ok(confidence >= 50, `expected a strong score, got ${confidence}`);
  assert.ok(reasons.some((r) => r.includes("making of")));
});

test("an ordinary film scores nothing", () => {
  for (const title of ["Alien", "Blade Runner", "The Thing", "Heat"]) {
    assert.equal(scoreCandidate(candidate(title)).confidence, 0, title);
  }
});

test("a standalone documentary is not demoted on that word alone", () => {
  // The worst thing this feature could do is hide a real documentary somebody
  // sat down to watch, so "documentary" by itself must stay below the bar.
  const g = guess(candidate("Grizzly Man", "A documentary about Timothy Treadwell."), known);
  assert.equal(g, null);
});

test("the same phrase is weaker in a synopsis than in a title", () => {
  const inTitle = scoreCandidate(candidate("Behind the Scenes of Alien")).confidence;
  const inOverview = scoreCandidate(candidate("Alien Special", "Behind the scenes footage.")).confidence;
  assert.ok(inOverview < inTitle, `${inOverview} should be below ${inTitle}`);
});

test("extracts the subject a title names", () => {
  assert.equal(extractSubject("The Making of Alien"), "Alien");
  assert.equal(extractSubject("Behind the Scenes of Blade Runner"), "Blade Runner");
  assert.equal(extractSubject("Dangerous Days"), null);
});

test("normalising drops case, punctuation and a leading article", () => {
  assert.equal(normaliseTitle("The Thing"), "thing");
  assert.equal(normaliseTitle("Blade Runner!"), "blade runner");
  assert.equal(normaliseTitle("  A   Film  "), "film");
});

test("proposes the film a making-of names, and its group", () => {
  const targets = proposeTargets(candidate("The Making of Alien"), known);
  assert.ok(targets.some((t) => t.kind === "film" && t.targetId === "film-alien"));
  assert.ok(targets.some((t) => t.kind === "franchise" && t.targetId === "group-alien"));
  // Most specific first, so the film leads.
  assert.equal(targets[0]!.kind, "film");
});

test("proposes a director named in the title", () => {
  const targets = proposeTargets(candidate("Hitchcock/Truffaut: Alfred Hitchcock on Film"), known);
  assert.ok(targets.some((t) => t.kind === "director" && t.targetId === "p-hitch"));
});

test("a one-word name is never proposed", () => {
  // "Cher" would otherwise match half the library. Full names only.
  const targets = proposeTargets(candidate("Cher: The Farewell Tour"), known);
  assert.ok(!targets.some((t) => t.targetId === "p-cher"));
});

test("film titles match whole, not as substrings", () => {
  // "Alien" appears inside this title but the subject is a different thing;
  // substring matching here would map half the library to Alien.
  const targets = proposeTargets(candidate("Alien Nation: A Retrospective"), known);
  assert.ok(!targets.some((t) => t.kind === "film" && t.targetId === "film-alien"));
});

test("a feature never proposes itself", () => {
  const self: KnownThings = { ...known, films: [{ id: "cand", title: "Alien" }] };
  const targets = proposeTargets(candidate("The Making of Alien"), self);
  assert.ok(!targets.some((t) => t.targetId === "cand"));
});

test("a strong signal with no target is still worth proposing", () => {
  // "Deleted Scenes" plainly does not belong in Browse even if we cannot work
  // out what it belongs to; a curator can map it by hand.
  const g = guess(candidate("Deleted Scenes"), known);
  assert.ok(g);
  assert.equal(g!.targets.length, 0);
});

test("a matched target raises confidence above the same title with none", () => {
  const withTarget = guess(candidate("The Making of Alien"), known)!;
  const withoutTarget = guess(candidate("The Making of Something Unowned"), known)!;
  assert.ok(withTarget.confidence > withoutTarget.confidence);
});

test("guessing never returns a plain film", () => {
  assert.equal(guess(candidate("Blade Runner"), known), null);
  assert.equal(guess(candidate("The Thing", "A crew in Antarctica."), known), null);
});
