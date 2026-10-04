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
    if (numbered && bold.length === 0) {
      // 2014 set its titles in nothing at all: "1. Boyhood<br />Without
      // wishing to indulge in hyperbole…". The title is the first line.
      const firstLine = tidy(cheerio.load(($p.html() ?? "").split(/<br\s*\/?>/i)[0] ?? "").text())
        .replace(/^\d{1,2}\s*\.\s*/, "")
        .replace(/\s*\(tie\)\s*$/i, "")
        .trim();
      if (firstLine && firstLine.length <= 80 && firstLine.length < text.length - 40) {
        const rest = text.slice(numbered[0].length);
        const capsule = rest.startsWith(firstLine) ? rest.slice(firstLine.length).replace(/^\s*\(tie\)/i, "").trim() : rest;
        current = { rank: Number(numbered[1]), title: firstLine, paragraphs: capsule ? [capsule] : [] };
        entries.push(current);
        return;
      }
    }
    if (numbered && bold.length > 0) {
      // The title is the link when the film was reviewed, else whatever is
      // bold once the number is taken off.
      // The entry's own number can sit outside the bold, inside it or inside
      // the link ("1. Days"). Only that number and its full stop come off:
      // "2046" and "4 Months, 3 Weeks and 2 Days" keep theirs.
      const rank = Number(numbered[1]);
      const ownNumber = new RegExp(`^${rank}\\s*\\.\\s*`);
      const tie = /\s*\(tie\)\s*/i;
      const linked = tidy(bold.find("a").first().text()).replace(ownNumber, "");
      const fromBold = tidy(bold.text()).replace(ownNumber, "");
      const title = (linked || fromBold).replace(tie, " ").trim();
      if (title) {
        let capsule = text.slice(numbered[0].length).replace(ownNumber, "");
        if (capsule.startsWith(title)) capsule = capsule.slice(title.length).replace(/^\s*\(tie\)/i, "").trim();
        current = { rank, title, paragraphs: capsule ? [capsule] : [] };
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
 * "The ten best films of … 1933". Never ranked, even where numbered ("the
 * list isn't in rank order"), and laid out four ways over the years, all
 * confirmed against the real posts for 1918 to 1935:
 *
 *   1. A paragraph that is nothing but the film's title in italics, with an
 *      optional bracket after it — the director, or the year under a still:
 *        <p><em><strong>Passing Fancy</strong></em></p>
 *        <p><strong><em>Lucky Star</em> (dir. Frank Borzage)</strong></p>
 *        <p><em>The Joyless Street</em> (1925).</p>
 *      (1920, 1925, 1928 onwards.)
 *   2. The title in bold italics inside the paragraph that discusses it
 *      (1926): "Vsevolod Pudovkin's <strong><em>Mother</em></strong> was …"
 *   3. A numbered paragraph whose first italic is the film (1918):
 *      "6. <em>Hell Bent</em>, by John Ford, was long thought …"
 *
 * What follows a film, up to the next one, is what is said about it. A bold
 * paragraph that is not italic is a section heading ("Hollywood, comic") and
 * ends the film before it. "Kristin here" opens the post; a title above that
 * line is the caption of the opening still. Runners-up end the list.
 *
 * In the years laid out by section (1921 to 1925, 1927, 1930) the films are
 * only named under their stills, so those come out as the films pictured:
 * usually close to the ten, not always exactly them.
 */
export function parseBordwellTenBest(html: string): ParsedCriticList | null {
  const $ = cheerio.load(html);
  const headline = tidy($("title").first().text()).replace(/^Observations on film art\s*:\s*/i, "");
  if (!headline) return null;
  const listYear = yearIn(headline);

  const bare = (text: string) => text.replace(/[\s.,:;–—-]+$/, "").trim();
  /** Takes "(dir. X)", "(Jean Vigo)" or "(1925)." off the end, as often as it is there. */
  const unbracket = (text: string): { core: string; year: number | null } => {
    let core = text.trim();
    let year: number | null = null;
    for (;;) {
      const m = /\s*\(([^()]*)\)\s*\.?$/.exec(core);
      if (!m) break;
      if (/^(18|19|20)\d{2}$/.test(m[1]!.trim())) year = Number(m[1]!.trim());
      core = core.slice(0, m.index);
    }
    return { core: bare(core), year };
  };

  const entries: CriticListEntry[] = [];
  const byTitle = new Map<string, CriticListEntry>();
  let current: CriticListEntry | null = null;
  let finished = false;
  // Prose since the last section heading that no film has claimed yet. In the
  // years laid out by section the still, and the title under it, come after
  // the paragraphs about the film; null until a section heading is seen, so
  // a post's introduction is never handed to its first film.
  let unclaimed: string[] | null = null;

  const film = (title: string): void => {
    const key = title.toLowerCase();
    const known = byTitle.get(key);
    if (known) {
      // Named again (its still, further down): what follows is still about it.
      current = known;
      return;
    }
    current = { rank: null, title, paragraphs: unclaimed ?? [] };
    if (unclaimed) unclaimed = [];
    byTitle.set(key, current);
    entries.push(current);
  };

  $(".entry p").each((_, el) => {
    if (finished) return;
    const $p = $(el);
    const text = tidy($p.text());
    if (!text) return;

    if (/^(kristin|kt|db|david)\b[^.]{0,40}\bhere\b/i.test(text) && text.length <= 60) {
      // The post starts now: whatever was named above is the opening still.
      // Later in a post the same words only hand the keyboard over.
      if (!entries.some((e) => e.paragraphs.length > 0)) {
        entries.length = 0;
        byTitle.clear();
        current = null;
      }
      return;
    }
    if (/runners?[\s-]?ups?\b/i.test(text.slice(0, 40))) {
      finished = true;
      return;
    }

    const bold = tidy($p.find("strong, b").text());
    const italic = tidy($p.find("em, i").first().text());
    const short = text.length <= 110;

    // 1. The paragraph is the title.
    if (short && italic) {
      const numbered = text.replace(/^\d{1,2}\s*\.\s*/, "");
      const whole = unbracket(numbered);
      const part = unbracket(italic.replace(/^\d{1,2}\s*\.\s*/, ""));
      if (whole.core && whole.core === part.core) {
        // A still from another year is a comparison, not an entry.
        if (whole.year !== null && listYear !== null && Math.abs(whole.year - listYear) > 1) return;
        film(whole.core);
        return;
      }
    }
    // A bold paragraph that is not a title: a section heading.
    if (short && bold && bare(bold) === bare(text)) {
      current = null;
      unclaimed = [];
      return;
    }
    // 2. Bold italics inside the paragraph that discusses the film: a short
    // run of bold that is italic through and through. (A whole paragraph set
    // in bold, with a foreign word in italics, is a quotation.)
    let boldItalic = "";
    $p.find("strong, b").each((_, node) => {
      if (boldItalic) return;
      const $b = $(node);
      const run = tidy($b.text());
      if (!run || run.length > 70) return;
      if (tidy($b.find("em, i").text()) === run || $b.closest("em, i").length > 0) boldItalic = run;
    });
    if (boldItalic && text.length > boldItalic.length + 60) {
      film(bare(boldItalic));
      current!.paragraphs.push(text);
      return;
    }
    // 3. A numbered paragraph whose first italic is the film.
    const numberedProse = /^(\d{1,2})\s*\.\s+/.exec(text);
    if (numberedProse && italic && text.length > 150) {
      film(bare(italic));
      current!.paragraphs.push(text.slice(numberedProse[0].length));
      return;
    }
    if (current) current.paragraphs.push(text);
    else if (unclaimed) unclaimed.push(text);
  });

  const written = entries.filter((e) => e.paragraphs.length > 0);
  if (written.length < MIN_ENTRIES) return null;
  return { headline, year: listYear, ranked: false, entries: written };
}

/** A Reverse Shot feature whose address says it is a best-of list, and not the year's worst. */
export function isReverseShotListSlug(slug: string): boolean {
  // The address has had four shapes: the_best_of_2006, best_2007,
  // reverse_shots_best_2013, best_of_2025. What they share is "best" and a
  // year. The same site's "11 offenses of …" is the year's worst.
  return /best/i.test(slug) && /(19|20)\d{2}/.test(slug) && !/offens|worst/i.test(slug);
}

/** One of the yearly ten-best posts, by its address. */
export function isBordwellTenBestUrl(url: string): boolean {
  return /\/blog\/\d{4}\/\d{2}\/\d{2}\/[^/]*best-films-of[^/]*\/?$/.test(url);
}
