import * as cheerio from "cheerio";

/**
 * Reads a Ringer article as a list of films, if it is one.
 *
 * Markup confirmed against live pages (2017–2026), not guessed. A list's
 * entries are headings — h2, h3 or h4 depending on the year the article was
 * written — of the form
 *
 *     10. <em>The Running Man </em>(1987)
 *     <strong>3. </strong><strong><em>28 Years Later</em></strong> (Nia DaCosta)
 *
 * and the paragraphs up to the next heading are what the writer says about
 * that film. The film's title is the italic, immediately after the number.
 *
 * That last condition is what separates a list of films from the site's many
 * other rankings. "John Wick's kills, ranked" and "The Sopranos characters,
 * ranked" have numbered headings too, but what follows the number is not a
 * title in italics; "5. Cameron Diaz in <em>Shrek</em>" has an italic, but not
 * first. Neither is read as a film list.
 *
 * Kept free of the database so it can be tested on its own.
 */

export interface RingerListEntry {
  /** Null in an unranked list. */
  rank: number | null;
  title: string;
  /** From a "(1987)" after the title. Null when the heading names the director instead. */
  year: number | null;
  /** The entry's own paragraphs. */
  paragraphs: string[];
}

export interface ParsedRingerList {
  headline: string;
  author: string | null;
  ranked: boolean;
  entries: RingerListEntry[];
}

/** Fewer than this and it is an article with a few subheadings, not a list. */
const MIN_ENTRIES = 5;

const PARAGRAPH = "p[data-sentry-source-file='paragraph.tsx']";

function clean(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

interface Heading {
  rank: number | null;
  title: string | null;
  year: number | null;
  /** An empty heading: a spacer the site puts between a title and its text. */
  empty: boolean;
}

const EM_RUN = "((?:<em>[^<]*</em>\\s*)+)";
const NUMBER_THEN_ITALIC = new RegExp(`^\\s*(\\d{1,3})\\.\\s*${EM_RUN}`);
/** "25. Galaxy Quest" was once set with the number inside the italic. */
const NUMBER_IN_ITALIC = /^\s*<em>\s*(\d{1,3})\.\s*([^<]*)<\/em>/;
const ITALIC_FIRST = new RegExp(`^\\s*${EM_RUN}`);

function readHeading($h: ReturnType<cheerio.CheerioAPI>): Heading {
  const text = clean($h.text());
  if (!text) return { rank: null, title: null, year: null, empty: true };

  // Bold and line breaks are decoration around the title; the italic is the
  // title. It must OPEN the heading (after the number, if there is one):
  // that is what makes the film the entry's subject rather than something
  // mentioned in passing. A title split across adjacent italics
  // ("<em>Les </em><em>Misérables</em>") is read as one.
  const markup = ($h.html() ?? "").replace(/<\/?(?:strong|b|br|span)[^>]*>/gi, "");
  const numbered = markup.match(NUMBER_THEN_ITALIC) ?? markup.match(NUMBER_IN_ITALIC);
  const plain = numbered ? null : markup.match(ITALIC_FIRST);
  const titleMarkup = numbered?.[2] ?? plain?.[1];

  const title = titleMarkup ? clean(cheerio.load(`<i>${titleMarkup}</i>`).text()) : "";
  const year = text.match(/\((\d{4})\)/)?.[1];
  return {
    rank: numbered ? Number.parseInt(numbered[1]!, 10) : null,
    title: title || null,
    year: year ? Number.parseInt(year, 10) : null,
    empty: false,
  };
}

/** A film named twice means the entries are something else: its characters, its scenes. */
function distinctTitles(entries: RingerListEntry[]): boolean {
  return new Set(entries.map((e) => e.title.toLowerCase())).size === entries.length;
}

export function parseRingerList(html: string): ParsedRingerList | null {
  const $ = cheerio.load(html);

  const headline = clean($("h1").first().text());
  if (!headline) return null;
  const author =
    $("a[aria-label^='Go to']").first().attr("aria-label")?.match(/^Go to (.+?)'s page$/)?.[1] ?? null;

  const ranked: RingerListEntry[] = [];
  const unranked: RingerListEntry[] = [];
  let current: RingerListEntry | null = null;

  $(`h2, h3, h4, ${PARAGRAPH}`).each((_, el) => {
    if (el.type !== "tag") return;

    if (el.name === "p") {
      const text = clean($(el).text());
      if (current && text) current.paragraphs.push(text);
      return;
    }

    const heading = readHeading($(el));
    // The 2025 best-of puts an empty heading between each title and its text.
    if (heading.empty) return;
    if (!heading.title) {
      // Any other heading ends the entry before it: "Honorable Mentions",
      // the site's own "Keep Exploring".
      current = null;
      return;
    }
    current = { rank: heading.rank, title: heading.title, year: heading.year, paragraphs: [] };
    (heading.rank === null ? unranked : ranked).push(current);
  });

  // A ranked list's unnumbered film headings are its honourable mentions,
  // which are not part of the ranking.
  if (ranked.length >= MIN_ENTRIES) {
    const seen = new Set<number>();
    const entries = ranked.filter((e) => !seen.has(e.rank!) && seen.add(e.rank!));
    if (entries.length >= MIN_ENTRIES && distinctTitles(entries)) {
      return { headline, author, ranked: true, entries: entries.sort((a, b) => a.rank! - b.rank!) };
    }
  }
  if (ranked.length === 0 && unranked.length >= MIN_ENTRIES && distinctTitles(unranked)) {
    return { headline, author, ranked: false, entries: unranked };
  }
  return null;
}

/**
 * The release year a list is about, when its headline says so ("The Best
 * Movies of 2023"). Those lists name the director after each title rather
 * than the year, and a title alone can match the wrong film.
 */
export function listYearFromHeadline(headline: string): number | null {
  const year = headline.match(/\b(?:of|in)\s+((?:19|20)\d{2})\b/i)?.[1];
  return year ? Number.parseInt(year, 10) : null;
}
