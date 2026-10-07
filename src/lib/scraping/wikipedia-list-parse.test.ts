import assert from "node:assert/strict";
import { test } from "node:test";

import { parseRankedTable, parseWinnersTables, redirectTarget, wikiDisplay } from "./wikipedia-list-parse.ts";

// The tables below are cut from the real pages' wikitext (2026-10-04).

test("ranked: cells joined on one line, rank first (AFI's 100 Thrills)", () => {
  const list = parseRankedTable(`{| class="wikitable sortable"
! #
! Film
! Director
! Year
|-
| 1 || ''[[Psycho (1960 film)|Psycho]]'' || {{sort|hitchcock|[[Alfred Hitchcock]]}} || [[1960 in film|1960]]
|-
| 3 || {{sort|exorcist|''[[The Exorcist]]''}} || {{sort|friedkin|[[William Friedkin]]}} || [[1973 in film|1973]]
|-
| 2 || ''[[Jaws (film)|Jaws]]''  || {{sort|spielberg|[[Steven Spielberg]]}} || [[1975 in film|1975]]
|}`);
  assert.deepEqual(list, [
    { rank: 1, title: "Psycho", year: 1960 },
    { rank: 2, title: "Jaws", year: 1975 },
    { rank: 3, title: "The Exorcist", year: 1973 },
  ]);
});

test("ranked: one cell per line, '1.' for a rank (AFI's 10th anniversary list)", () => {
  const list = parseRankedTable(`{| class="wikitable sortable"
|-
! Rank
! 10th anniversary list (2007)
! Director
! Year
|-
| 1.
| ''[[Citizen Kane]]''
|{{Hs|Welles}}[[Orson Welles]]
| 1941
|-
| 2.
| ''[[The Godfather]]''
| [[Francis Ford Coppola]]
| 1972
|}`);
  assert.deepEqual(list.map((e) => [e.rank, e.title, e.year]), [[1, "Citizen Kane", 1941], [2, "The Godfather", 1972]]);
});

test("ranked: no row dividers, cells closed with <td> (the BBC's list)", () => {
  const list = parseRankedTable(`{| class="wikitable sortable"
! No. !! Title !! Director !! Country !! Year </tr>
| 1 ||''[[Mulholland Drive (film)|Mulholland Drive]]''<td>[[David Lynch]]</td><td>[[Cinema of the United States|United States]]</td><td> 2001
| 5 || ''[[Boyhood (2014 film)|Boyhood]]'' || [[Richard Linklater]] || rowspan="3"|United States || 2014 </tr>
| 6 || ''[[Eternal Sunshine of the Spotless Mind]]'' || [[Michel Gondry]] ||2004 </tr>
|}`);
  assert.deepEqual(list.map((e) => [e.rank, e.title, e.year]), [
    [1, "Mulholland Drive", 2001],
    [5, "Boyhood", 2014],
    // The country cell is spanned from the row above; the year is still found.
    [6, "Eternal Sunshine of the Spotless Mind", 2004],
  ]);
});

test("winners: the year in an ordinary cell, the winner by its background (BAFTA)", () => {
  const list = parseWinnersTables(`{| class="wikitable"
|-
! Year
! Film
! Director(s)
|-
| rowspan="3"| {{center|'''1950'''<br>{{small|([[4th British Academy Film Awards|4th]])}}}}
| style="background:#FAEB86"| '''''[[All About Eve]]''''' †
| style="background:#FAEB86"| '''[[Joseph L. Mankiewicz]]'''
|-
| ''[[The Asphalt Jungle]]''
| [[John Huston]]
|-
| ''[[Beauty and the Devil]]'' (''La Beauté du diable'')
| [[René Clair]]
|}`);
  assert.deepEqual(list, [{ year: 1950, title: "All About Eve" }]);
});

test("winners: the year in a header cell, cells joined on a line (César)", () => {
  const list = parseWinnersTables(`{| class="wikitable"
|-
!Year
!English title
!Original title
|-
! rowspan="3" style="text-align:center;" |2010<br>([[35th César Awards|35th]])
| style="background:#eedd82;" |'''''[[A Prophet]]'''''|| style="background:#eedd82;" |'''''Un prophète'''''
|-
|''[[In the Beginning (2009 film)|In the Beginning]]''||''À l'origine''
|-
|colspan="2"|''[[Rapt (2009 film)|Rapt]]''||[[Lucas Belvaux]]
|}`);
  assert.deepEqual(list, [{ year: 2010, title: "A Prophet" }]);
});

test("winners: a year with two, and nothing but being a year to mark its cell (LAFCA)", () => {
  const list = parseWinnersTables(`{| class="wikitable"
|-
! '''Year'''
! '''Film'''
|-
|style="text-align:center;"| 2012 || '''''[[Amour (2012 film)|Amour]]'''''± || [[Michael Haneke]]
|-
|rowspan="2" style="text-align:center;"| 2013 || '''''[[Gravity (2013 film)|Gravity]]'''''± || [[Alfonso Cuarón]]
|-
| '''''[[Her (2013 film)|Her]]'''''± || [[Spike Jonze]]
|}`);
  assert.deepEqual(list, [
    { year: 2012, title: "Amour" },
    { year: 2013, title: "Gravity" },
    { year: 2013, title: "Her" },
  ]);
});

test("winners: a page that marks nothing lists winners only (New York critics)", () => {
  const list = parseWinnersTables(`{| class="wikitable"
|-
!Year
!Winner
|-
! style="text-align:center;" |2020
| ''[[First Cow]]''<ref>[https://example.org a source]</ref>
|-
! style="text-align:center;" |2021
|''[[Drive My Car (film)|Drive My Car]]''
|}`);
  assert.deepEqual(list, [{ year: 2020, title: "First Cow" }, { year: 2021, title: "Drive My Car" }]);
});

test("winners: asked for every row, nominees come too", () => {
  const table = `{| class="wikitable"
|-
! Year !! Film
|-
! 2010
| style="background:#b0c4de;" | '''''[[The Social Network]]'''''
|-
| ''[[Black Swan (film)|Black Swan]]''
|}`;
  assert.equal(parseWinnersTables(table).length, 1);
  assert.equal(parseWinnersTables(table, { winnersOnly: true }).length, 2);
});

test("a film whose title is a year is a title, and italics inside the link are still a title", () => {
  const list = parseWinnersTables(`{| class="wikitable"
|-
! Year !! Film
|-
! 2019
| '''''[[1917 (2019 film)|1917]]'''''
|-
! 2025
| '''[[Hamnet (film)|''Hamnet'']]'''
|}`);
  assert.deepEqual(list, [{ year: 2019, title: "1917" }, { year: 2025, title: "Hamnet" }]);
});

test("display text and redirects", () => {
  assert.equal(wikiDisplay("{{center|'''1950'''<br>{{small|([[4th British Academy Film Awards|4th]])}}}}"), "1950 (4th)");
  assert.equal(wikiDisplay("{{sort|Last Circus|''[[The Last Circus]]''}}<ref>x</ref>"), "The Last Circus");
  assert.equal(redirectTarget("#REDIRECT [[National Society of Film Critics Award for Best Picture]]\n\n{{R from move}}"), "National Society of Film Critics Award for Best Picture");
  assert.equal(redirectTarget("{{Short description|A film award}}"), null);
});
