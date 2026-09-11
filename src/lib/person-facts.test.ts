import assert from "node:assert/strict";
import { test } from "node:test";

import { personFacts } from "./person-facts.ts";

test("a full life reads as one line", () => {
  assert.equal(
    personFacts({ born: "1906-05-08", died: "1977-06-03", birthplace: "Rome, Italy" }),
    "Born 8 May 1906 in Rome, Italy  ·  Died 3 June 1977",
  );
});

test("someone living has no death date, and no gap where it would be", () => {
  assert.equal(
    personFacts({ born: "1970-07-30", died: null, birthplace: "London, England, UK" }),
    "Born 30 July 1970 in London, England, UK",
  );
});

test("a birthplace alone is still worth saying", () => {
  assert.equal(personFacts({ born: null, died: null, birthplace: "Paris" }), "Born in Paris");
});

test("nothing known is nothing shown, not an empty line", () => {
  assert.equal(personFacts({ born: null, died: null, birthplace: null }), null);
  assert.equal(personFacts(null), null);
});

test("a malformed date is left out rather than printed as Invalid Date", () => {
  assert.equal(
    personFacts({ born: "sometime", died: null, birthplace: "Naples" }),
    "Born in Naples",
  );
});
