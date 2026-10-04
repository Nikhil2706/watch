import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isBordwellTenBestUrl,
  isReverseShotListSlug,
  parseBordwellTenBest,
  parseReverseShotBestOf,
} from "./critic-list-parse.ts";

const LONG = "A sentence long enough to be prose rather than a caption under a still, and then a little more of it. ";

function reverseShot(entries: string[]): string {
  return `<div class="article-header"><h2>Reverse Shot’s Best of 2025</h2></div>
    <div class="article-text"><p>An introduction to the year.</p>${entries.join("\n")}</div>`;
}

test("Reverse Shot: number, linked title, capsule", () => {
  const list = parseReverseShotBestOf(
    reverseShot([
      `<p><img src="a.jpg" /></p><p>1. <strong><a href="/reviews/entry/1/x">One Battle After Another</a></strong><br />${LONG}—A Writer</p>`,
      `<p>2. <strong><a href="/reviews/entry/2/x">Caught by the Tides</a></strong><br />${LONG}</p>`,
      `<p><strong>3</strong><strong>.</strong><strong> <a href="/reviews/entry/3/x">The Secret Agent</a></strong><br />${LONG}</p>`,
      `<p>4. <strong>Blue Moon</strong><br />${LONG}</p><p>${LONG}</p>`,
      `<p>5. <strong><a href="/reviews/entry/5/x">Cloud</a></strong><br />${LONG}</p>`,
    ]),
  );
  assert.ok(list);
  assert.equal(list.year, 2025);
  assert.equal(list.ranked, true);
  assert.deepEqual(
    list.entries.map((e) => [e.rank, e.title]),
    [
      [1, "One Battle After Another"],
      [2, "Caught by the Tides"],
      [3, "The Secret Agent"],
      [4, "Blue Moon"],
      [5, "Cloud"],
    ],
  );
  // The capsule, without the number and the title in front of it.
  assert.ok(list.entries[0]!.paragraphs[0]!.startsWith("A sentence long enough"));
  // A second paragraph belongs to the same film.
  assert.equal(list.entries[3]!.paragraphs.length, 2);
});

test("Reverse Shot: an article that is not a list", () => {
  assert.equal(
    parseReverseShotBestOf(reverseShot([`<p>1. <strong>One thing</strong> ${LONG}</p>`, `<p>${LONG}</p>`])),
    null,
  );
});

function bordwell(body: string, title = "The ten best films of &#8230; 1933"): string {
  return `<html><head><title>Observations on film art : ${title}</title></head><body><div class="entry">${body}</div></body></html>`;
}

const FILMS = ["Dragnet Girl", "Passing Fancy", "Design for Living", "Duck Soup", "King Kong"];

test("Bordwell: a film is a paragraph that is only its bold title", () => {
  const list = parseBordwellTenBest(
    bordwell(
      `<p><em><strong>Dragnet Girl </strong>(1933).</em></p><p><strong>Kristin here &#8211;</strong></p><p>${LONG}</p>` +
        FILMS.map((f) => `<p><em><strong>${f}</strong></em></p><p><a href="x.jpg"><img src="x.jpg" /></a></p><p>${LONG}</p><p>${LONG}</p>`).join("") +
        `<p><em><strong>Duck Soup</strong></em></p>`,
    ),
  );
  assert.ok(list);
  assert.equal(list.year, 1933);
  assert.equal(list.ranked, false);
  assert.deepEqual(list.entries.map((e) => e.title), FILMS);
  assert.ok(list.entries.every((e) => e.rank === null && e.paragraphs.length === 2));
});

test("Bordwell: numbered films are still not ranked, and the opening caption is not film one", () => {
  const list = parseBordwellTenBest(
    bordwell(
      `<p><em><strong>Dragnet Girl</strong></em></p><p><strong>Kristin here:</strong></p><p>${LONG}</p>` +
        FILMS.map((f, i) => `<p><strong><em>${i + 1}. ${f}.</em></strong></p><p>${LONG}</p>`).join(""),
      "The ten best films of &#8230; 1928",
    ),
  );
  assert.ok(list);
  assert.equal(list.ranked, false);
  assert.deepEqual(
    list.entries.map((e) => [e.rank, e.title, e.paragraphs.length]),
    FILMS.map((f) => [null, f, 1]),
  );
});

test("Bordwell: a director or a year in brackets is not part of the title", () => {
  const list = parseBordwellTenBest(
    bordwell(
      `<p><strong>Kristin here:</strong></p>` +
        FILMS.map((f, i) =>
          i % 2
            ? `<p><strong><em>${f}</em> (dir. Some Body)</strong></p><p>${LONG}</p>`
            : `<p><strong><em>${f}</em> (aka Another Name) (Some Body)</strong></p><p>${LONG}</p>`,
        ).join(""),
    ),
  );
  assert.ok(list);
  assert.deepEqual(list.entries.map((e) => e.title), FILMS);
});

test("Bordwell: bold italics inside the paragraph that discusses the film", () => {
  const list = parseBordwellTenBest(
    bordwell(
      `<p><strong>Kristin here:</strong></p><p><strong>The Russians are coming</strong></p>` +
        FILMS.map((f) => `<p>Somebody&#8217;s <strong><em>${f}</em></strong> was ${LONG}</p><p>${LONG}</p>`).join("") +
        // A quotation set whole in bold, with one foreign word in italics, is not a film.
        `<p><strong>${LONG} A <em>cinéaste</em> would say so. ${LONG}</strong></p>` +
        // Handing the keyboard over does not start the post again.
        `<p><strong>David here:</strong></p><p>${LONG}</p>`,
    ),
  );
  assert.ok(list);
  assert.deepEqual(list.entries.map((e) => e.title), FILMS);
  assert.equal(list.entries[0]!.paragraphs.length, 2);
});

test("Bordwell: a still's caption follows the paragraphs about its film", () => {
  const list = parseBordwellTenBest(
    bordwell(
      `<p><strong>Kristin here:</strong></p><p>${LONG}</p>` +
        FILMS.map(
          (f) => `<p><strong>A section heading</strong></p><p>${LONG}</p><p>${LONG}</p><p><em><strong>${f}</strong> (1933).</em></p>`,
        ).join("") +
        // A still from another year is a comparison.
        `<p><em>An Older Film</em> (1919).</p><p><strong>Some runners-up</strong></p><p><em>Also Ran</em> (1933).</p><p>${LONG}</p>`,
    ),
  );
  assert.ok(list);
  assert.deepEqual(list.entries.map((e) => e.title), FILMS);
  assert.ok(list.entries.every((e) => e.paragraphs.length === 2));
});

test("Bordwell: an ordinary post is not a list", () => {
  assert.equal(parseBordwellTenBest(bordwell(`<p><strong>DB here:</strong></p><p>${LONG}</p><p>${LONG}</p>`)), null);
});

test("which addresses are lists", () => {
  assert.equal(isReverseShotListSlug("best_of_2025"), true);
  assert.equal(isReverseShotListSlug("11_offenses_of_2025"), false);
  assert.equal(isReverseShotListSlug("body_double"), false);
  assert.equal(isBordwellTenBestUrl("https://www.davidbordwell.net/blog/2023/12/31/the-ten-best-films-of-1933/"), true);
  assert.equal(
    isBordwellTenBestUrl("https://www.davidbordwell.net/blog/2019/04/08/the-criterion-channel-the-best-news-for-film-culture-you-will-hear-today-and-probably-all-year/"),
    false,
  );
});
