import assert from "node:assert/strict";
import { test } from "node:test";

import { looksLikeWikiMarkup } from "./wiki-markup.ts";

test("catches the infobox that reached the film page", () => {
  assert.equal(
    looksLikeWikiMarkup("{{Infobox film | name = Sympathy for Mr. Vengeance | image = sfmvposter2.jpg |"),
    true,
  );
  assert.equal(looksLikeWikiMarkup("directed by [[Park Chan-wook]]"), true);
  assert.equal(looksLikeWikiMarkup("| caption = Promotional release poster"), true);
  assert.equal(looksLikeWikiMarkup("It grossed $1m.<ref>Box Office Mojo</ref>"), true);
  assert.equal(looksLikeWikiMarkup("== Reception =="), true);
});

test("leaves real prose alone, pipes and equals signs included", () => {
  assert.equal(looksLikeWikiMarkup("A brutal, beautiful film — Park's best."), false);
  assert.equal(looksLikeWikiMarkup("Two stars | the critics were split."), false);
  assert.equal(looksLikeWikiMarkup("Revenge = regret, as the film keeps telling us."), false);
});
