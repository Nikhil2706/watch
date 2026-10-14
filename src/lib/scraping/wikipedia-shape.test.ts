/**
 * Tests for reading Wikipedia REST responses.
 *
 * Run:
 *   node --test --experimental-strip-types \
 *        --disable-warning=ExperimentalWarning src/lib/scraping/wikipedia-shape.test.ts
 *
 * The nightly backfill failed about 30 films a night with "Cannot read
 * properties of null (reading 'source')" ("Phantasm III: Lord of the Dead"
 * among them). Every null below used to reach code that dereferenced it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { pickFilmPageTitle, readPageSource, readSearchHits } from "./wikipedia-shape.ts";

test("a whole page is read as it is", () => {
  assert.deepEqual(
    readPageSource({ id: 1, key: "Phantasm_III", title: "Phantasm III: Lord of the Dead", source: "'''Phantasm III''' is a 1994 film." }),
    { title: "Phantasm III: Lord of the Dead", source: "'''Phantasm III''' is a 1994 film." },
  );
});

test("a null page, or a page with null source or title, is no article", () => {
  assert.equal(readPageSource(null), null);
  assert.equal(readPageSource(undefined), null);
  assert.equal(readPageSource({ title: "Phantasm III: Lord of the Dead", source: null }), null);
  assert.equal(readPageSource({ title: "Phantasm III: Lord of the Dead" }), null);
  assert.equal(readPageSource({ title: null, source: "text" }), null);
  assert.equal(readPageSource({ title: "Phantasm III", source: "" }), null);
  assert.equal(readPageSource({ title: "Phantasm III", source: "   " }), null);
  // An error body sent with a 200, and a bare string.
  assert.equal(readPageSource({ httpCode: 404, httpReason: "Not Found", messageTranslations: {} }), null);
  assert.equal(readPageSource("Phantasm"), null);
});

test("search hits: the film one is preferred, otherwise the first", () => {
  const hits = readSearchHits({
    pages: [
      { title: "Phantasm (franchise)", description: "Horror franchise" },
      { title: "Phantasm III: Lord of the Dead", description: "1994 film by Don Coscarelli" },
    ],
  });
  assert.equal(pickFilmPageTitle(hits), "Phantasm III: Lord of the Dead");
  assert.equal(pickFilmPageTitle(readSearchHits({ pages: [{ title: "Phantasm", description: null }] })), "Phantasm");
});

test("null or missing search results mean no page, not a crash", () => {
  for (const json of [null, undefined, {}, { pages: null }, { pages: "x" }, { pages: [] }, { pages: [null, 3, {}] }]) {
    assert.deepEqual(readSearchHits(json), [], JSON.stringify(json));
    assert.equal(pickFilmPageTitle(readSearchHits(json)), null);
  }
});

test("a hit with a null title is skipped; a null description is not a reason to skip", () => {
  const hits = readSearchHits({
    pages: [
      { title: null, description: "1994 film" },
      { title: "Phantasm III: Lord of the Dead", description: null, thumbnail: null },
    ],
  });
  assert.deepEqual(hits, [{ title: "Phantasm III: Lord of the Dead", description: null }]);
  assert.equal(pickFilmPageTitle(hits), "Phantasm III: Lord of the Dead");
});
