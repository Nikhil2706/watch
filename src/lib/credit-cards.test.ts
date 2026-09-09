import assert from "node:assert/strict";
import { test } from "node:test";

import { mergeCredits, type JellyfinPerson, type TmdbCredit } from "./credit-cards.ts";
import { rankSimilar } from "./similar-rank.ts";

/* ------------------------------------------------------------------ *
 * Merging two sources into one Cast row and one Crew row
 * ------------------------------------------------------------------ */

const jf = (o: Partial<JellyfinPerson> & { Name: string; Type: string }): JellyfinPerson => ({
  Id: `jf-${o.Name}`,
  Role: undefined,
  ...o,
});

const tm = (o: Partial<TmdbCredit> & { name: string; department: string }): TmdbCredit => ({
  tmdbId: 1,
  profilePath: null,
  job: "",
  ord: 0,
  ...o,
});

test("Jellyfin cast lead, and keep their link and photo", () => {
  const { cast } = mergeCredits(
    [jf({ Name: "Yves Montand", Type: "Actor", Role: "Mario", PrimaryImageTag: "abc" })],
    [],
  );
  assert.equal(cast.length, 1);
  assert.equal(cast[0]!.role, "Mario");
  assert.equal(cast[0]!.href, "/person/jf-Yves Montand");
  assert.deepEqual(cast[0]!.photo, { kind: "jellyfin", id: "jf-Yves Montand", tag: "abc" });
});

test("a Jellyfin person with no portrait falls back to initials, not a broken image", () => {
  const { cast } = mergeCredits([jf({ Name: "Vera Clouzot", Type: "Actor" })], []);
  assert.equal(cast[0]!.photo, null);
  assert.equal(cast[0]!.initials, "VC");
});

/**
 * The whole reason this module exists: Jellyfin holds no cinematographer for
 * anything, so without the TMDB side the Crew row is Director/Writer/Producer
 * and nothing else.
 */
test("TMDB fills the crew Jellyfin has never held", () => {
  const { crew } = mergeCredits(
    [jf({ Name: "Henri-Georges Clouzot", Type: "Director" })],
    [
      tm({ name: "Armand Thirard", department: "cinematographers", tmdbId: 10, profilePath: "/a.jpg" }),
      tm({ name: "Henri Rust", department: "editors", tmdbId: 11 }),
    ],
  );
  assert.deepEqual(
    crew.map((c) => `${c.name}: ${c.role}`),
    [
      "Henri-Georges Clouzot: Director",
      "Armand Thirard: Cinematography",
      "Henri Rust: Editor",
    ],
  );
  assert.deepEqual(crew[1]!.photo, { kind: "tmdb", tmdbId: 10 });
  // No Jellyfin id, so the card points at the TMDB person page instead — the
  // one that answers "what else of theirs is here" out of tmdb_credits.
  assert.equal(crew[1]!.href, "/person/tmdb/10");
  // TMDB has no headshot for 57% of crew; those must not get a photo slot.
  assert.equal(crew[2]!.photo, null);
});

test("one person with two jobs is one card", () => {
  const { crew } = mergeCredits(
    [
      jf({ Name: "Henri-Georges Clouzot", Type: "Director" }),
      jf({ Name: "Henri-Georges Clouzot", Type: "Writer" }),
    ],
    [],
  );
  assert.equal(crew.length, 1);
  assert.equal(crew[0]!.role, "Director · Screenplay");
});

test("the same person from both sources is one card, and Jellyfin wins the identity", () => {
  const { crew } = mergeCredits(
    [jf({ Name: "Paco Plaza", Type: "Director", PrimaryImageTag: "tag" })],
    [tm({ name: "Paco Plaza", department: "writers", tmdbId: 99, profilePath: "/p.jpg" })],
  );
  assert.equal(crew.length, 1);
  assert.equal(crew[0]!.role, "Director · Screenplay");
  // The Jellyfin identity is kept because only it can be linked.
  assert.equal(crew[0]!.href, "/person/jf-Paco Plaza");
  assert.deepEqual(crew[0]!.photo, { kind: "jellyfin", id: "jf-Paco Plaza", tag: "tag" });
});

test("an accented name matches its unaccented spelling", () => {
  const { crew } = mergeCredits(
    [jf({ Name: "Jaume Balagueró", Type: "Director" })],
    [tm({ name: "Jaume Balaguero", department: "writers", tmdbId: 3 })],
  );
  assert.equal(crew.length, 1);
  assert.equal(crew[0]!.role, "Director · Screenplay");
});

/** Real: Pablo Rosso shot [REC] and appears in it. He belongs in both rows. */
test("someone in both cast and crew appears in both rows", () => {
  const { cast, crew } = mergeCredits(
    [jf({ Name: "Pablo Rosso", Type: "Actor", Role: "Pablo" })],
    [tm({ name: "Pablo Rosso", department: "cinematographers", tmdbId: 5 })],
  );
  assert.equal(cast.length, 1);
  assert.equal(crew.length, 1);
  assert.equal(crew[0]!.role, "Cinematography");
});

test("crew are ordered by department, not by which source supplied them", () => {
  const { crew } = mergeCredits(
    [jf({ Name: "A Producer", Type: "Producer" })],
    [
      tm({ name: "An Editor", department: "editors", tmdbId: 1 }),
      tm({ name: "A Director", department: "directors", tmdbId: 2 }),
      tm({ name: "A Designer", department: "productionDesigners", tmdbId: 3 }),
    ],
  );
  assert.deepEqual(
    crew.map((c) => c.name),
    ["A Director", "An Editor", "A Designer", "A Producer"],
  );
});

test("the cast is capped, and the cap counts both sources together", () => {
  const many = Array.from({ length: 25 }, (_, i) => jf({ Name: `Actor ${i}`, Type: "Actor" }));
  const { cast } = mergeCredits(many, [tm({ name: "Extra", department: "cast", tmdbId: 7 })]);
  assert.equal(cast.length, 20);
});

test("an item with no people at all produces two empty rows, not a crash", () => {
  const { cast, crew } = mergeCredits([], []);
  assert.deepEqual(cast, []);
  assert.deepEqual(crew, []);
});

/* ------------------------------------------------------------------ *
 * Ranking "More like this" by TMDB agreement
 * ------------------------------------------------------------------ */

const item = (Id: string, imdbId?: string) => ({ Id, imdbId: imdbId ?? null });

test("titles TMDB also recommends move to the front and are flagged", () => {
  const ranked = rankSimilar(
    [item("a", "tt1"), item("b", "tt2"), item("c", "tt3")],
    new Set(["tt3"]),
  );
  assert.deepEqual(
    ranked.items.map((i) => i.Id),
    ["c", "a", "b"],
  );
  assert.deepEqual([...ranked.endorsed], ["c"]);
});

/**
 * The common case, by measurement: 57% of films have nothing owned that TMDB
 * also suggests. The row must be exactly what it is today for those.
 */
test("with no endorsement the order is untouched", () => {
  const ranked = rankSimilar([item("a", "tt1"), item("b", "tt2")], new Set());
  assert.deepEqual(
    ranked.items.map((i) => i.Id),
    ["a", "b"],
  );
  assert.equal(ranked.endorsed.size, 0);
  assert.equal(ranked.addedByTmdb, 0);
});

test("Jellyfin's own order survives inside each half", () => {
  const ranked = rankSimilar(
    [item("a", "tt1"), item("b", "tt2"), item("c", "tt3"), item("d", "tt4")],
    new Set(["tt2", "tt4"]),
  );
  assert.deepEqual(
    ranked.items.map((i) => i.Id),
    ["b", "d", "a", "c"],
  );
});

test("an item with no IMDb id can never be endorsed, and is not dropped", () => {
  const ranked = rankSimilar([item("a"), item("b", "tt2")], new Set(["tt2"]));
  assert.deepEqual(
    ranked.items.map((i) => i.Id),
    ["b", "a"],
  );
});

test("a title only TMDB found is appended rather than lost", () => {
  const ranked = rankSimilar([item("a", "tt1")], new Set(), [item("z", "tt9")]);
  assert.deepEqual(
    ranked.items.map((i) => i.Id),
    ["a", "z"],
  );
  assert.equal(ranked.addedByTmdb, 1);
  assert.ok(ranked.endorsed.has("z"));
});

test("an extra already in Jellyfin's list is not added twice", () => {
  const ranked = rankSimilar([item("a", "tt1")], new Set(["tt1"]), [item("a", "tt1")]);
  assert.equal(ranked.items.length, 1);
  assert.equal(ranked.addedByTmdb, 0);
});

test("the reported additions count only what survived the limit", () => {
  const base = Array.from({ length: 12 }, (_, i) => item(`j${i}`, `tt${i}`));
  const ranked = rankSimilar(base, new Set(), [item("z", "tt99")], 12);
  assert.equal(ranked.items.length, 12);
  // The appended one fell off the end, so claiming it was added would be a lie.
  assert.equal(ranked.addedByTmdb, 0);
  assert.equal(ranked.endorsed.size, 0);
});
