import { test } from "node:test";
import assert from "node:assert/strict";

import { accChips, bestFirst, freshCandidates, mentionBadge, mentions, passageScore, railLine, sanitizeRichText, slotBody, sourceBar, sourceColours, surprisePick, visibleFilms, wrapTag, type AccFilm } from "./accolades-view.ts";

const film = (imdbId: string, over: Partial<AccFilm> = {}): AccFilm => ({
  imdbId,
  name: imdbId,
  year: 2000,
  posterUrl: null,
  articles: 0,
  blurbCandidates: 0,
  triviaCandidates: 0,
  hasMaterial: false,
  curated: false,
  blurbChosen: false,
  triviaChosen: 0,
  accoladeChosen: false,
  ...over,
});

test("filters, sort by material, and the rail line", () => {
  const films = [film("a", { hasMaterial: true, articles: 1 }), film("b", { hasMaterial: true, articles: 3 }), film("c", { curated: true, blurbChosen: true })];
  assert.deepEqual(visibleFilms(films, "material", "", "material").map((f) => f.imdbId), ["b", "a"]);
  assert.deepEqual(visibleFilms(films, "all", "", "name").map((f) => f.imdbId), ["a", "b", "c"]);
  assert.equal(accChips(films, "material").find((c) => c.key === "blurb")!.count, 1);
  assert.deepEqual(railLine(films[1]!), { sub: "3 articles", dot: "warn" });
  assert.deepEqual(railLine(films[2]!), { sub: "done", dot: "accent" });
});

test("surprise picks from the best-stocked third", () => {
  const films = [film("a", { hasMaterial: true, articles: 9 }), film("b", { hasMaterial: true, articles: 1 }), film("c", { hasMaterial: true, articles: 2 })];
  assert.equal(surprisePick(films, () => 0.99)!.imdbId, "a");
  assert.equal(surprisePick([film("x")]), null);
});

test("readable passages first", () => {
  assert.ok(passageScore("x".repeat(150)) > passageScore("x".repeat(30)));
  assert.ok(passageScore("x".repeat(150)) > passageScore("x".repeat(900)));
  const { shown, hidden } = bestFirst(["short", "x".repeat(150), "y".repeat(900)], (t) => t, false, 1);
  assert.equal(shown[0], "x".repeat(150));
  assert.equal(hidden, 2);
});

test("mentions and their badges", () => {
  const list = mentions([{ id: "l", accolade_label: "Won: Best Picture", accolade_rank: null, article_title: "Oscars", source_name: "Wikipedia" }], [{ id: "e", slot: 2, accolade_name: "My top ten" }]);
  assert.deepEqual(list.map((m) => [m.kind, m.label]), [["link", "Won: Best Picture"], ["entry", "#3"]]);
  assert.deepEqual(mentionBadge("Won: Best Picture"), { trophy: true, rank: "•" });
  assert.deepEqual(mentionBadge("#7 in AFI"), { trophy: false, rank: "#7" });
});

test("rich text keeps only the allowed tags, and wraps a selection", () => {
  assert.equal(sanitizeRichText('<b class="x">hi</b><script>x</script><i>y</I>'), "<b>hi</b>x<i>y</i>");
  assert.deepEqual(wrapTag("hello world", 0, 5, "b"), { value: "<b>hello</b> world", start: 0, end: 12 });
  assert.deepEqual(wrapTag("abc", 1, 1, "b"), { value: "abc", start: 1, end: 1 });
});

test("source colours and bars", () => {
  const c = sourceColours(["a", "b", "a"]);
  assert.notEqual(c.a, c.b);
  assert.deepEqual(sourceBar({ article_count: 50, matched_count: 25 }, 100), { width: 50, matched: 25 });
});

test("builder rows: edit in place or insert at a position", () => {
  assert.deepEqual(slotBody({ title: "  ", blurb: "", imdbId: null, year: null, slot: 0, insertAt: null }), { error: "Title required." });
  assert.deepEqual(slotBody({ title: "Heat", blurb: "", imdbId: "tt1", year: 1995, slot: 3, insertAt: null }), { title: "Heat", blurb_text: null, imdb_id: "tt1", year: 1995, slot: 3 });
  assert.deepEqual(slotBody({ title: "Heat", blurb: "b", imdbId: null, year: null, slot: null, insertAt: 0 }), { title: "Heat", blurb_text: "b", insert_at: 0 });
});

test("candidates already chosen, or repeated, are offered once", () => {
  const c = [{ t: "A line." }, { t: "a  line." }, { t: "Chosen" }, { t: "Other" }];
  assert.deepEqual(freshCandidates(c, (x) => x.t, ["chosen"]).map((x) => x.t), ["A line.", "Other"]);
});
