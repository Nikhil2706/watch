import assert from "node:assert/strict";
import { test } from "node:test";

import { creditsFromPayload, isCacheableImagePath } from "./tmdb-shape.ts";

/**
 * The thing worth pinning down is the filtering.
 *
 * TMDB hands back every credit it holds — 1,102 stunt performers across this
 * library — and the film page can name six crew jobs. Everything here is about
 * what survives that cut and what happens to the awkward cases: one person with
 * two jobs, a job spelled a second way, a credit with no id.
 */

const payload = (cast: unknown[], crew: unknown[]) => ({ credits: { cast, crew } });

test("keeps only the crew jobs the page can name", () => {
  const out = creditsFromPayload(
    payload(
      [],
      [
        { id: 1, name: "Armand Thirard", job: "Director of Photography" },
        { id: 2, name: "A Stunt Double", job: "Stunt Double" },
        { id: 3, name: "Georges Auric", job: "Original Music Composer" },
        { id: 4, name: "Best Boy", job: "Best Boy Electric" },
      ],
    ),
  );

  assert.deepEqual(
    out.map((c) => c.name),
    ["Armand Thirard", "Georges Auric"],
  );
  assert.equal(out[0]!.department, "cinematographers");
  assert.equal(out[1]!.department, "composers");
});

test("buckets both spellings TMDB uses for a job", () => {
  const out = creditsFromPayload(
    payload(
      [],
      [
        { id: 1, name: "One", job: "Director of Photography" },
        { id: 2, name: "Two", job: "Cinematography" },
      ],
    ),
  );
  assert.deepEqual(new Set(out.map((c) => c.department)), new Set(["cinematographers"]));
});

/**
 * Real case: Henri-Georges Clouzot directed The Wages of Fear and co-wrote it.
 * Both credits are true and the Crew row shows one card saying so, which it
 * cannot do if the second credit is deduplicated away.
 */
test("keeps two credits for one person on the same title", () => {
  const out = creditsFromPayload(
    payload(
      [],
      [
        { id: 7, name: "Henri-Georges Clouzot", job: "Director" },
        { id: 7, name: "Henri-Georges Clouzot", job: "Screenplay" },
      ],
    ),
  );
  assert.equal(out.length, 2);
  assert.deepEqual(
    out.map((c) => c.department),
    ["directors", "writers"],
  );
});

/** Also real: Pablo Rosso shot [REC] and appears in it. */
test("keeps a person credited as both cast and crew", () => {
  const out = creditsFromPayload(
    payload(
      [{ id: 9, name: "Pablo Rosso", character: "Pablo", order: 1 }],
      [{ id: 9, name: "Pablo Rosso", job: "Director of Photography" }],
    ),
  );
  assert.equal(out.length, 2);
  assert.deepEqual(
    out.map((c) => c.department),
    ["cast", "cinematographers"],
  );
  assert.equal(out[0]!.job, "Pablo");
});

test("drops the same credit listed twice", () => {
  const out = creditsFromPayload(
    payload([], [
      { id: 5, name: "Twice", job: "Editor" },
      { id: 5, name: "Twice", job: "Editor" },
    ]),
  );
  assert.equal(out.length, 1);
});

test("ignores a credit with no id or no name", () => {
  const out = creditsFromPayload(
    payload([], [
      { name: "No id", job: "Editor" },
      { id: 6, job: "Editor" },
      { id: 8, name: "Fine", job: "Editor" },
    ]),
  );
  assert.deepEqual(
    out.map((c) => c.name),
    ["Fine"],
  );
});

test("caps the cast at twenty, in TMDB's own order", () => {
  const cast = Array.from({ length: 30 }, (_, i) => ({
    id: 100 + i,
    name: `Actor ${i}`,
    character: `Role ${i}`,
    order: i,
  }));
  const out = creditsFromPayload(payload(cast, []));
  assert.equal(out.length, 20);
  assert.equal(out[0]!.name, "Actor 0");
  assert.equal(out[19]!.name, "Actor 19");
});

test("reads a show's aggregate_credits as well as a film's credits", () => {
  const out = creditsFromPayload({
    aggregate_credits: {
      cast: [{ id: 1, name: "Martin Sheen", character: "Josiah Bartlet", order: 0 }],
      crew: [{ id: 2, name: "Thomas Del Ruth", job: "Director of Photography" }],
    },
  });
  assert.deepEqual(
    out.map((c) => c.name),
    ["Martin Sheen", "Thomas Del Ruth"],
  );
});

test("survives a payload with no credits at all", () => {
  assert.deepEqual(creditsFromPayload(null), []);
  assert.deepEqual(creditsFromPayload({}), []);
  assert.deepEqual(creditsFromPayload({ credits: {} }), []);
});

test("carries the profile path through, and null when there is none", () => {
  const out = creditsFromPayload(
    payload([], [
      { id: 1, name: "Has one", job: "Editor", profile_path: "/abc123.jpg" },
      { id: 2, name: "Has none", job: "Director", profile_path: null },
    ]),
  );
  assert.equal(out[0]!.profilePath, "/abc123.jpg");
  assert.equal(out[1]!.profilePath, null);
});

/**
 * The path is interpolated into an outbound fetch, so it is validated rather
 * than trusted even though it arrives from a cached payload rather than a URL.
 */
test("only accepts TMDB's own file-path shape", () => {
  assert.equal(isCacheableImagePath("/8MTHVfhHBgXrqTNHs83rQiSfBYh.png"), true);
  assert.equal(isCacheableImagePath("/abc123.jpg"), true);

  assert.equal(isCacheableImagePath("abc123.jpg"), false);
  assert.equal(isCacheableImagePath("/../../etc/passwd"), false);
  assert.equal(isCacheableImagePath("/abc 123.jpg"), false);
  assert.equal(isCacheableImagePath("/abc.jpg?x=1"), false);
  assert.equal(isCacheableImagePath("//evil.example/x.jpg"), false);
  assert.equal(isCacheableImagePath("/abc.gif"), false);
  assert.equal(isCacheableImagePath(""), false);
});
