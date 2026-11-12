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

/* ---- extras left in a show's folder ---- */

const ANGEL = "/media/TV/Angel.s01.1999.dvdrip.x264";
const NR = "/media/TV/NewsRadio [.x264 DVD Rips] Commentaries, Subtitles, Extras";
const shows: KnownThings = {
  films: [],
  groups: [
    { id: "g-angel", name: "Angel", kind: "series", paths: [`${ANGEL}/Angel.1x01.City_Of.x264.mkv`, `${ANGEL}/Angel.1x02.Lonely_Hearts.x264.mkv`] },
    { id: "g-nr", name: "NewsRadio", kind: null, paths: [`${NR}/Season 01/01 - s1e01 - Pilot.mkv`, `${NR}/Season 05/76 - s5e01 - Bill Moves On.mkv`] },
    { id: "g-out1", name: "Out 1", kind: "movie", paths: ["/media/French/Rivette/Out 1 - Part 1.mkv"] },
    { id: "g-flat", name: "Flat", kind: "series", paths: ["/media/TV/Flat S01E01.mkv", "/media/TV/Flat S01E02.mkv"] },
    { id: "g-medici", name: "The Age of the Medici", kind: null, paths: ["/media/Italian/Rossellini/L'eta di Cosimo.mkv", "/media/Italian/Rossellini/L'eta di Cosimo (2).mkv"] },
  ],
  people: [],
};
const at = (path: string, title = path.slice(path.lastIndexOf("/") + 1)) => ({ itemId: "x", title, year: null, overview: null, path });

test("an extra beside a show's episodes is proposed for that show, with a clean name", () => {
  const g = guess(at(`${ANGEL}/Angel.1xEX.I'm_Cordelia.dvdrip.x264.mkv`, "Angel.1xEX.I'm_Cordelia"), shows);
  assert.ok(g);
  assert.ok(g.confidence >= 50);
  assert.deepEqual(g.targets.map((t) => [t.kind, t.targetId]), [["franchise", "g-angel"]]);
  assert.equal(g.suggestedName, "I'm Cordelia");
});

test("an extra in a season folder of a show nobody linked is still that show's", () => {
  const g = guess(at(`${NR}/Season 03/Season 3 Bloopers.mkv`), shows);
  assert.ok(g);
  assert.equal(g.targets[0]?.targetId, "g-nr");
  assert.equal(g.suggestedName, "Season 3 Bloopers");
  assert.equal(guess(at(`${NR}/Season 05/One Man NewsRadio - Joe Furey 01.mkv`), shows)?.suggestedName, "One Man NewsRadio - Joe Furey 01");
});

test("the folder rule never claims an episode, a film's folder, or a library root", () => {
  // An episode not yet grouped: it has its own marker.
  assert.equal(guess(at(`${ANGEL}/Angel.1x03.In_the_Dark.x264.mkv`), shows), null);
  // A member of the group itself.
  assert.equal(guess(at(`${ANGEL}/Angel.1x01.City_Of.x264.mkv`), shows), null);
  // Beside a film kept in parts: other films share such folders.
  assert.equal(guess(at("/media/French/Rivette/Celine and Julie Go Boating.mkv"), shows), null);
  // Directly under the TV root, where the "Flat" show's file also is.
  assert.equal(guess(at("/media/TV/Something Else.mkv"), shows), null);
  // A mini-series whose parts carry no episode numbers, in a director's folder.
  assert.equal(guess(at("/media/Italian/Rossellini/Socrates 1971.mkv"), shows), null);
});

test("extra names", async () => {
  const { extraName } = await import("./special-feature-guess.ts");
  assert.equal(extraName(`${ANGEL}/Angel.1xEX.Season_1_Overview.dvdrip.x264.mkv`, "Angel"), "Season 1 Overview");
  assert.equal(extraName(`${ANGEL}/Angel.1xEX.Introducing_Angel.dvdrip.x264.mkv`, "Angel"), "Introducing Angel");
  assert.equal(extraName("/m/TV/Show/Show - Extras - Gag Reel.mkv", "Show"), "Gag Reel");
  assert.equal(extraName("/m/TV/Show/Making of Space Episode.mkv", "Show"), "Making of Space Episode");
});
