import assert from "node:assert/strict";
import { test } from "node:test";

import { listYearFromHeadline, parseRingerList } from "./ringer-list-parse.ts";

const P = (text: string) => `<p data-sentry-source-file="paragraph.tsx">${text}</p>`;

function page(headline: string, body: string): string {
  return `<html><body><h1>${headline}</h1>
    <a aria-label="Go to Adam Nayman's page" href="/creator/adam-nayman">Adam Nayman</a>
    ${body}
    <h2>Keep Exploring</h2>${P("Not part of any entry.")}</body></html>`;
}

// The shapes below are the live site's, one per era of its markup.
const RANKED = page(
  "The 10 Best Stephen King Movie Adaptations",
  `${P("An introduction that belongs to no film.")}
   <h3 id="">Honorable Mentions</h3>
   <h4 id=""><em>Misery </em>(1990)</h4>${P("A mention, not a ranking.")}
   <h3 id="">5. <em>The Mist </em>(2007)</h3>${P("Five, first paragraph.")}${P("Five, second paragraph.")}
   <h3 id="">4. <em>Christine </em>(1983)</h3>${P("Four.")}
   <h3 id=""><br>3. <em>The Dead Zone </em>(1983)</h3>${P("Three.")}
   <h4 id=""><em>2. Carrie </em>(1976)</h4>${P("Two.")}
   <h2 id=""><strong>1. </strong><strong><em>The Shining</em></strong> (Stanley Kubrick)</h2>${P("One.")}`,
);

test("a ranked list: numbers, titles, years, and each entry's own paragraphs", () => {
  const list = parseRingerList(RANKED);
  assert.ok(list);
  assert.equal(list.headline, "The 10 Best Stephen King Movie Adaptations");
  assert.equal(list.author, "Adam Nayman");
  assert.equal(list.ranked, true);
  assert.deepEqual(
    list.entries.map((e) => [e.rank, e.title, e.year]),
    [
      [1, "The Shining", null],
      [2, "Carrie", 1976],
      [3, "The Dead Zone", 1983],
      [4, "Christine", 1983],
      [5, "The Mist", 2007],
    ],
  );
  assert.deepEqual(list.entries[4]!.paragraphs, ["Five, first paragraph.", "Five, second paragraph."]);
  // The site's own trailing section is not the last film's text.
  assert.deepEqual(list.entries[0]!.paragraphs, ["One."]);
});

test("honourable mentions are not part of a ranking", () => {
  const list = parseRingerList(RANKED);
  assert.ok(list);
  assert.equal(list.entries.some((e) => e.title === "Misery"), false);
});

test("a ranking of something other than films is not a film list", () => {
  const kills = page(
    "Every John Wick Kill, Ranked",
    [1, 2, 3, 4, 5, 6].map((n) => `<h3 id="">${n}. The pencil</h3>${P("A kill.")}`).join(""),
  );
  assert.equal(parseRingerList(kills), null);

  const performances = page(
    "Cameron Diaz's Best Performances",
    [1, 2, 3, 4, 5, 6].map((n) => `<h3 id="">${n}. Cameron Diaz in <em>Shrek</em></h3>${P("A role.")}`).join(""),
  );
  assert.equal(parseRingerList(performances), null);
});

test("an essay with a few subheadings is not a list", () => {
  const essay = page(
    "What Has Stephen King Been Trying to Tell Us?",
    `<h3 id="">1. <em>It</em> (2017)</h3>${P("One.")}<h3 id="">2. <em>Cujo</em> (1983)</h3>${P("Two.")}`,
  );
  assert.equal(parseRingerList(essay), null);
});

test("an unnumbered run of film headings is an unranked list", () => {
  const unranked = page(
    "Seven Films for a Long Weekend",
    ["Heat", "Thief", "Collateral", "Manhunter", "Ali"]
      .map((t) => `<h3 id=""><em>${t}</em> (1995)</h3>${P(`About ${t}.`)}`)
      .join(""),
  );
  const list = parseRingerList(unranked);
  assert.ok(list);
  assert.equal(list.ranked, false);
  assert.deepEqual(list.entries.map((e) => e.rank), [null, null, null, null, null]);
  assert.deepEqual(list.entries.map((e) => e.title), ["Heat", "Thief", "Collateral", "Manhunter", "Ali"]);
});

test("a year-end headline gives the year its films came out", () => {
  assert.equal(listYearFromHeadline("The Best Movies of 2023"), 2023);
  assert.equal(listYearFromHeadline("The 10 Best Movies of 2026 (So Far)"), 2026);
  assert.equal(listYearFromHeadline("The 25 Best Space Movies, Ranked"), null);
});
