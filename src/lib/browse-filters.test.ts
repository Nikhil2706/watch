/**
 * Tests for the Browse page's filtering logic.
 *
 * Run:
 *   node --test --experimental-strip-types \
 *        --disable-warning=ExperimentalWarning src/lib/browse-filters.test.ts
 *
 * These import browse-filters.ts directly, which is only possible because that
 * module has zero runtime imports. browse-data.ts cannot be loaded this way
 * (server-only + the SQLite handle), which is exactly how the decade filter
 * managed to be completely broken without anything noticing.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  decadeOf,
  facetLinkValue,
  filterMovies,
  isFacetSelected,
  parseDecade,
  type FilterableMovie,
} from "./browse-filters.ts";

function movie(partial: Partial<FilterableMovie> = {}): FilterableMovie {
  return { year: null, genres: [], directors: [], actors: [], ...partial };
}

const library: FilterableMovie[] = [
  movie({ year: 1994, genres: ["Crime", "Drama"], directors: ["Tarantino"], actors: ["Travolta"] }),
  movie({ year: 1999, genres: ["Drama"], directors: ["Fincher"], actors: ["Norton", "Pitt"] }),
  movie({ year: 2001, genres: ["Fantasy"], directors: ["Jackson"], actors: ["McKellen"] }),
  movie({ year: 1975, genres: ["Drama"], directors: ["Forman"], actors: ["Nicholson"] }),
  movie({ year: null, genres: ["Documentary"], directors: [], actors: [] }),
];

/* ---------------- the actual regression ----------------
 *
 * The real defect was NOT in filterMovies — given "1990" it always worked.
 * It was the wiring: the sidebar linked the facet's display *name* ("1990s")
 * while filterMovies expects its *id* ("1990"), so every decade filter matched
 * nothing. A test that calls filterMovies directly with the right form passes
 * against the broken code and proves nothing, so the contract is tested as a
 * round trip: the value the sidebar links must select that facet's films.
 */

// Shaped exactly as decadeCounts()/genreCounts() in browse-data.ts emit them.
const decadeFacets = [
  { id: "1990", name: "1990s" },
  { id: "2000", name: "2000s" },
  { id: "1970", name: "1970s" },
];
const genreFacets = [
  { id: "Drama", name: "Drama" },
  { id: "Crime", name: "Crime" },
];

test("round trip: every decade facet's linked value selects its films", () => {
  for (const facet of decadeFacets) {
    const linked = facetLinkValue(facet);
    const got = filterMovies(library, "decade", linked);
    assert.ok(
      got.length > 0,
      `facet ${facet.name} linked ?value=${linked} but matched no films`,
    );
    for (const m of got) {
      assert.equal(String(decadeOf(m.year)), facet.id, `${facet.name} matched a film from ${m.year}`);
    }
  }
});

test("round trip: every genre facet's linked value selects its films", () => {
  for (const facet of genreFacets) {
    const got = filterMovies(library, "genre", facetLinkValue(facet));
    assert.ok(got.length > 0, `genre ${facet.name} matched no films`);
    for (const m of got) assert.ok(m.genres.includes(facet.name));
  }
});

test("round trip: a linked facet is also rendered as selected", () => {
  // Guards the other half of the contract - the row the user clicked must
  // light up. These two used different comparisons before the fix.
  for (const facet of [...decadeFacets, ...genreFacets]) {
    const dim = facet.id === facet.name ? "genre" : "decade";
    assert.ok(
      isFacetSelected(facet, dim, facetLinkValue(facet)),
      `${facet.name} did not read as selected from its own link`,
    );
  }
});

test("decade filter matches films when given the bare decade", () => {
  const got = filterMovies(library, "decade", "1990");
  assert.equal(got.length, 2, "1990s should contain the 1994 and 1999 films");
  assert.deepEqual(
    got.map((m) => m.year).sort(),
    [1994, 1999],
  );
});

test("decade filter also accepts the display form, so old links keep working", () => {
  // Pre-fix the sidebar linked ?value=1990s. Those URLs may be bookmarked or
  // shared, and must not silently produce an empty grid.
  assert.deepEqual(
    filterMovies(library, "decade", "1990s").map((m) => m.year).sort(),
    [1994, 1999],
  );
});

test("a decade with no films returns empty, not everything", () => {
  assert.equal(filterMovies(library, "decade", "1920").length, 0);
});

test("a malformed decade returns empty rather than the whole library", () => {
  // Returning every film here would make a typo look like a working filter.
  assert.equal(filterMovies(library, "decade", "nineties").length, 0);
  assert.equal(filterMovies(library, "decade", "").length, 0);
});

test("films with no year never match a decade", () => {
  const all = library.flatMap((m) => ["1970", "1990", "2000"].map((d) => filterMovies([m], "decade", d)));
  const matchedUnyeared = all.flat().filter((m) => m.year === null);
  assert.equal(matchedUnyeared.length, 0);
});

/* ---------------- the other dimensions ---------------- */

test("genre filter", () => {
  assert.equal(filterMovies(library, "genre", "Drama").length, 3);
  assert.equal(filterMovies(library, "genre", "Crime").length, 1);
  assert.equal(filterMovies(library, "genre", "Western").length, 0);
});

test("director filter", () => {
  assert.equal(filterMovies(library, "director", "Fincher").length, 1);
  assert.equal(filterMovies(library, "director", "Kubrick").length, 0);
});

test("actor filter matches any billed actor, not just the lead", () => {
  assert.equal(filterMovies(library, "actor", "Pitt").length, 1);
  assert.equal(filterMovies(library, "actor", "Norton").length, 1);
});

test("genre matching is exact, not substring", () => {
  // "Drama" must not pull in "Documentary" or vice versa.
  assert.equal(filterMovies(library, "genre", "Dram").length, 0);
  assert.equal(filterMovies(library, "genre", "Doc").length, 0);
});

test("a null value means no filter, for every dimension", () => {
  for (const dim of ["genre", "director", "actor", "decade"] as const) {
    assert.equal(filterMovies(library, dim, null).length, library.length, dim);
  }
});

test("filterMovies does not mutate or reorder its input", () => {
  const before = [...library];
  filterMovies(library, "genre", "Drama");
  assert.deepEqual(library, before);
});

/* ---------------- helpers ---------------- */

test("decadeOf", () => {
  assert.equal(decadeOf(1994), 1990);
  assert.equal(decadeOf(2000), 2000);
  assert.equal(decadeOf(2009), 2000);
  assert.equal(decadeOf(null), null);
});

test("parseDecade accepts both forms and rejects junk", () => {
  assert.equal(parseDecade("1990"), 1990);
  assert.equal(parseDecade("1990s"), 1990);
  assert.equal(parseDecade(" 1990s "), 1990);
  assert.equal(parseDecade("199"), 199);
  assert.equal(parseDecade("19900"), null);
  assert.equal(parseDecade("abc"), null);
  assert.equal(parseDecade(""), null);
});

test("isFacetSelected highlights the right row", () => {
  const nineties = { id: "1990", name: "1990s" };
  const eighties = { id: "1980", name: "1980s" };

  assert.equal(isFacetSelected(nineties, "decade", "1990"), true);
  // A pre-fix bookmarked link should still light up the row.
  assert.equal(isFacetSelected(nineties, "decade", "1990s"), true);
  assert.equal(isFacetSelected(eighties, "decade", "1990"), false);
  assert.equal(isFacetSelected(nineties, "decade", null), false);

  const drama = { id: "Drama", name: "Drama" };
  assert.equal(isFacetSelected(drama, "genre", "Drama"), true);
  assert.equal(isFacetSelected(drama, "genre", "Crime"), false);
});
