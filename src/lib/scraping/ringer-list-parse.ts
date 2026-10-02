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
}

function readHeading($h: ReturnType<cheerio.CheerioAPI>): Heading {
  const text = clean($h.text());
  const em = clean($h.find("em").first().text());

  const numbered = text.match(/^(\d{1,3})\.\s*(.*)$/);
  const rest = numbered ? numbered[2]! : text;
  const rank = numbered ? Number.parseInt(numbered[1]!, 10) : null;

  // "25. Galaxy Quest" was once set with the number inside the italic.
  const emTitle = clean(em.replace(/^\d{1,3}\.\s*/, ""));
  // The italic must open the heading: that is what makes it the entry's
  // subject rather than a film mentioned in passing.
  const title = emTitle && rest.startsWith(emTitle) ? emTitle : null;

  const year = rest.match(/\((\d{4})\)/)?.[1];
  return { rank, title, year: year ? Number.parseInt(year, 10) : null };
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
    if (entries.length >= MIN_ENTRIES) {
      return { headline, author, ranked: true, entries: entries.sort((a, b) => a.rank! - b.rank!) };
    }
  }
  if (ranked.length === 0 && unranked.length >= MIN_ENTRIES) {
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
