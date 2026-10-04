import * as cheerio from "cheerio";

/**
 * Reads the two lists the review sites publish besides their reviews:
 * Reverse Shot's annual "Best of" feature, and the "ten best films of …"
 * post Kristin Thompson writes each year on David Bordwell's site about the
 * year ninety years back. Pure, so it can be tested; critic-lists.ts does
 * the fetching.
 *
 * Markup confirmed against live pages on 2026-10-04 (Reverse Shot's Best of
 * 2025; the ten best films of 1933), not guessed.
 */

export interface CriticListEntry {
  /** Null in a list its writer does not rank. */
  rank: number | null;
  title: string;
  /** What the list says about this film and no other. */
  paragraphs: string[];
}

export interface ParsedCriticList {
  headline: string;
  /** The year the list is about: the films' year, not the year it was written. */
  year: number | null;
  ranked: boolean;
  entries: CriticListEntry[];
}

function tidy(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function yearIn(text: string): number | null {
  const m = text.match(/\b(18|19|20)\d{2}\b/);
  return m ? Number(m[0]) : null;
}

/** A list with fewer entries than this is an article that happens to number something. */
const MIN_ENTRIES = 5;

/**
 * Reverse Shot's Best of the year. Each entry is one paragraph of
 * `.article-text`:
 *
 *     1. <strong><a href="/reviews/…">One Battle After Another</a></strong><br />
 *     The capsule… —Writer
 *
 * with the number sometimes inside the bold instead
 * (`<strong>5</strong><strong>.</strong><strong> <a>The Secret Agent</a></strong>`).
 * The paragraphs between entries are stills.
 */
export function parseReverseShotBestOf(html: string): ParsedCriticList | null {
  const $ = cheerio.load(html);
  const headline = tidy($(".article-header h2").first().text());
  if (!headline) return null;

  const entries: CriticListEntry[] = [];
  let current: CriticListEntry | null = null;

  $(".article-text p").each((_, el) => {
    const $p = $(el);
    const text = tidy($p.text());
    if (!text) return;

    const numbered = text.match(/^(\d{1,2})\s*\.\s*/);
    const bold = $p.find("strong, b");
    if (numbered && bold.length > 0) {
      // The title is the link when the film was reviewed, else whatever is
      // bold once the number is taken off.
      const linked = tidy(bold.find("a").first().text());
      const fromBold = tidy(bold.text()).replace(/^\d{1,2}\s*\.?\s*/, "");
      const title = linked || fromBold;
      if (title) {
        let capsule = text.slice(numbered[0].length);
        if (capsule.startsWith(title)) capsule = capsule.slice(title.length).trim();
        current = { rank: Number(numbered[1]), title, paragraphs: capsule ? [capsule] : [] };
        entries.push(current);
        return;
      }
    }
    // A capsule that runs to a second paragraph.
    if (current) current.paragraphs.push(text);
  });

  if (entries.length < MIN_ENTRIES) return null;
  return { headline, year: yearIn(headline), ranked: true, entries };
}

/**
 * "The ten best films of … 1933". Each film has a paragraph to itself that is
 * nothing but its title in bold, numbered in the older posts and not in the
 * newer:
 *
 *     <p><em><strong>Passing Fancy</strong></em></p>
 *     <p><strong><em>1. La passion de Jeanne d'Arc.</em></strong></p>
 *
 * Stills follow, then the prose, up to the next such paragraph. A bold title
 * with a year after it ("Dragnet Girl (1933).") is the caption of the still
 * above it, and "Kristin here" opens the post in bold without being a film.
 * The same title standing alone a second time is a closing still.
 */
export function parseBordwellTenBest(html: string): ParsedCriticList | null {
  const $ = cheerio.load(html);
  const headline = tidy($("title").first().text()).replace(/^Observations on film art\s*:\s*/i, "");
  if (!headline) return null;

  const bare = (text: string) => text.replace(/[\s.,:;–—-]+$/, "").trim();
  const entries: CriticListEntry[] = [];
  const byTitle = new Map<string, CriticListEntry>();
  let current: CriticListEntry | null = null;

  $(".entry p").each((_, el) => {
    const $p = $(el);
    const text = tidy($p.text());
    if (!text) return;

    const bold = tidy($p.find("strong, b").text());
    if (bold) {
      if (/\bhere\b/i.test(bold) && text.length <= bold.length + 5) {
        // "Kristin here:" — the post starts now. A title above this line was
        // the caption of the opening still, and what follows is the
        // introduction, not that film's text.
        entries.length = 0;
        byTitle.clear();
        current = null;
        return;
      }
      const standsAlone = bare(text) === bare(bold) && bold.length <= 90 && !/\bhere\b/i.test(bold);
      if (!standsAlone) {
        // A caption, the opening line, or bold inside prose. Prose belongs to
        // the film being discussed; a caption is neither kept nor a break.
        if (current && text.length > bold.length + 60) current.paragraphs.push(text);
        return;
      }
      const numbered = bare(bold).match(/^(\d{1,2})\s*\.\s*(.+)$/);
      const title = bare(numbered ? numbered[2]! : bold);
      const rank = numbered ? Number(numbered[1]) : null;
      const key = title.toLowerCase();
      const known = byTitle.get(key);
      if (known && known.paragraphs.length > 0) {
        current = null;
        return;
      }
      if (known) {
        // Named once above as a still's caption, before anything was said.
        known.rank = rank;
        current = known;
        return;
      }
      current = { rank, title, paragraphs: [] };
      byTitle.set(key, current);
      entries.push(current);
      return;
    }
    if (current) current.paragraphs.push(text);
  });

  const written = entries.filter((e) => e.paragraphs.length > 0);
  if (written.length < MIN_ENTRIES) return null;
  return { headline, year: yearIn(headline), ranked: written.every((e) => e.rank !== null), entries: written };
}

/** A Reverse Shot feature whose address says it is a best-of list, and not the year's worst. */
export function isReverseShotListSlug(slug: string): boolean {
  return /best_of|best_films|ten_best|top_ten/i.test(slug) && !/offens|worst/i.test(slug);
}

/** One of the yearly ten-best posts, by its address. */
export function isBordwellTenBestUrl(url: string): boolean {
  return /\/blog\/\d{4}\/\d{2}\/\d{2}\/[^/]*best-films-of[^/]*\/?$/.test(url);
}
