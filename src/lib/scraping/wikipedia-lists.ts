import "server-only";

import { upsertScrapedArticle, type FilmMentionInput } from "./articles";
import { fetchWikipediaPageByTitle, stripWikitext } from "./wikipedia";

/**
 * Ingests a Wikipedia LIST page (a ranked "100 best" list, or a festival's
 * year-by-year winners list) — as opposed to wikipedia.ts, which fetches a
 * single FILM's own page. Same publisher, same fetch mechanics (reused from
 * there), different shape of page: one page here mentions many films, each
 * landing as its own accolade mention against the same scraped_articles row
 * (the list page itself), same pattern yearendlists.ts uses for a listicle.
 *
 * Table markup varies more here than a film infobox does (rowspan-shared
 * year cells, one-line "||"-joined cells vs. one-cell-per-line, "no award
 * given" placeholder rows), so both parsers below are best-effort — verified
 * against real fetched pages for the specific titles this was built for
 * (AFI's 100 Years...100 Movies; Academy Award for Best Picture; Palme d'Or;
 * Golden Lion), not a general wikitext table parser.
 */

const YEAR_RE = /\b(1[89]\d{2}|20\d{2})\b/;

/** [[Link]], [[Link|Display]], or the same inside {{sort|Key|...}} — prefers the display text when present. */
function extractWikilinkTitle(cell: string): string | null {
  const match = cell.match(/\[\[([^[\]|]+)(?:\|([^[\]]+))?\]\]/);
  if (!match) return null;
  const raw = (match[2] ?? match[1] ?? "").trim();
  return raw.length > 0 ? raw : null;
}

/** Rows of a `{| ... |}` wikitable, one row per array of raw cell strings (attributes stripped, marker char removed) — does not distinguish header (!) from data (|) cells; use extractHeaderCells for that. */
function splitTableRows(table: string): string[] {
  return table.split(/\n\|-/).slice(1);
}

/** Splits one row into cells, keeping the ! vs | marker per cell — needed for tables where the year lives in a `!` cell shared via rowspan across several `|` data rows. */
function splitRowCellsWithMarker(row: string): Array<{ isHeader: boolean; text: string }> {
  // The row string starts with the rest of the "|-" line (often just style
  // attributes) up to the first newline — not a cell, discard it.
  const body = row.slice(row.indexOf("\n") + 1);
  const lines = body.split(/\n(?=[!|])/);
  const cells: Array<{ isHeader: boolean; text: string }> = [];
  for (const line of lines) {
    const isHeader = line.startsWith("!");
    const marker = isHeader ? "!!" : "\\|\\|";
    const parts = line
      .slice(1)
      .split(new RegExp(marker))
      .map((p) => p.trim())
      // A leading `align="left" |` / `style="..." |` cell-attribute segment
      // is itself separated by a single `|` before the real content — drop
      // it when present (a plain `|` inside the split segment).
      .map((p) => {
        const attrSplit = p.indexOf("|");
        return attrSplit >= 0 && attrSplit < 60 && /^[a-z-]+\s*=/.test(p) ? p.slice(attrSplit + 1).trim() : p;
      });
    for (const text of parts) cells.push({ isHeader, text });
  }
  return cells;
}

// --- AFI-style ranked lists ---------------------------------------------

export interface ParsedRankedEntry {
  rank: number;
  title: string;
  year: number | null;
}

/**
 * "Film | Release year | Director | Production companies | ... Rank" —
 * verified against AFI's 100 Years...100 Movies. `rankColumnHint` picks
 * between multiple rank columns when a list carries more than one (e.g.
 * "1998 Rank" and "2007 Rank" — pass a substring like "2007" to prefer the
 * updated ranking; omitted, the LAST rank-like column wins, which is the
 * more recent one on every AFI list checked).
 */
export function parseAfiRankedList(wikitext: string, rankColumnHint?: string): ParsedRankedEntry[] {
  const tableMatch = wikitext.match(/\{\|[\s\S]*?\n\|\}/);
  if (!tableMatch) return [];
  const table = tableMatch[0];

  const headerLine = table.split("\n").find((l) => l.trim().startsWith("!"));
  if (!headerLine) return [];
  const headers = headerLine
    .replace(/^!/, "")
    .split("!!")
    .map((h) => h.trim());

  const filmCol = headers.findIndex((h) => /film/i.test(h));
  const yearCol = headers.findIndex((h) => /year/i.test(h));
  const rankCols = headers.map((h, i) => ({ h, i })).filter(({ h }) => /rank/i.test(h));
  const rankCol = (rankColumnHint ? rankCols.find(({ h }) => h.includes(rankColumnHint)) : undefined)?.i ?? rankCols.at(-1)?.i;
  if (filmCol === -1 || rankCol === undefined) return [];

  const entries: ParsedRankedEntry[] = [];
  for (const row of splitTableRows(table)) {
    const cells = row
      .slice(row.indexOf("\n") + 1)
      .split("||")
      .map((c) => c.replace(/^\n?\|/, "").trim());
    if (cells.length <= Math.max(filmCol, rankCol)) continue;

    const title = extractWikilinkTitle(cells[filmCol]!);
    const rank = Number.parseInt(stripWikitext(cells[rankCol]!), 10);
    if (!title || !Number.isFinite(rank)) continue;

    const year = yearCol >= 0 && cells[yearCol] ? Number.parseInt(stripWikitext(cells[yearCol]), 10) : null;
    entries.push({ rank, title, year: Number.isFinite(year) ? year : null });
  }

  return entries.sort((a, b) => a.rank - b.rank);
}

// --- Year-by-year winners lists (Oscars, Palme d'Or, Golden Lion) ------

export interface ParsedWinnerEntry {
  year: number;
  title: string;
}

/**
 * A page built from several `{| ... |}` tables (one per decade), each row
 * either carrying a `!`-marked year cell (rowspan across every winner/
 * nominee that year) or continuing the most recently seen year. For a
 * "winners only" page (Palme d'Or, Golden Lion) every row is a result; for
 * a "winner + nominees" page (Academy Award for Best Picture) only the row
 * paired with the year cell is the actual winner — bold+italic markup
 * (''''') on the title is the second, corroborating signal, so a row only
 * counts as a winner when EITHER it carries the year cell OR its title is
 * wrapped in ''''' — whichever page shape this turns out to be.
 */
export function parseYearWinnersTable(wikitext: string, opts: { winnersOnly: boolean }): ParsedWinnerEntry[] {
  const entries: ParsedWinnerEntry[] = [];
  const tables = wikitext.match(/\{\|[\s\S]*?\n\|\}/g) ?? [];

  for (const table of tables) {
    let currentYear: number | null = null;

    for (const row of splitTableRows(table)) {
      const cells = splitRowCellsWithMarker(row);
      if (cells.length === 0) continue;

      const yearCell = cells.find((c) => c.isHeader);
      const isYearRow = Boolean(yearCell);
      if (yearCell) {
        const m = yearCell.text.match(YEAR_RE);
        if (m) currentYear = Number.parseInt(m[1]!, 10);
      }
      if (currentYear === null) continue;

      const dataCells = cells.filter((c) => !c.isHeader);
      const titleCell = dataCells.find((c) => extractWikilinkTitle(c.text));
      if (!titleCell) continue;

      const isBoldWinner = /'''''/.test(titleCell.text);
      const counts = opts.winnersOnly || isYearRow || isBoldWinner;
      if (!counts) continue;

      const title = extractWikilinkTitle(titleCell.text);
      if (title) entries.push({ year: currentYear, title });
    }
  }

  return entries;
}

export interface WikipediaListIngestResult {
  pageTitle: string;
  entriesFound: number;
  matchedCount: number;
}

/**
 * Fetches one Wikipedia list/awards page and stores every entry as a
 * ranked (AFI-style) or won (awards-style) accolade mention against the
 * page's own scraped_articles row — same "one page, many mentions" shape
 * as yearendlists.ts. `awardLabel` (e.g. "Academy Award for Best Picture")
 * is used to build each won entry's accolade_label; ignored for ranked
 * lists, which use accolade_rank instead.
 */
export async function runWikipediaListIngest(opts: {
  pageTitle: string;
  kind: "ranked" | "winners";
  rankColumnHint?: string;
  winnersOnly?: boolean;
  awardLabel?: string;
}): Promise<WikipediaListIngestResult | null> {
  const page = await fetchWikipediaPageByTitle(opts.pageTitle);
  if (!page) return null;

  let mentions: FilmMentionInput[];
  let entriesFound: number;

  if (opts.kind === "ranked") {
    const parsed = parseAfiRankedList(page.source, opts.rankColumnHint);
    entriesFound = parsed.length;
    mentions = parsed.map((e) => ({
      rawTitle: e.title,
      rawYear: e.year,
      accoladeRank: e.rank,
      skipCandidateExtraction: true,
    }));
  } else {
    const parsed = parseYearWinnersTable(page.source, { winnersOnly: opts.winnersOnly ?? true });
    entriesFound = parsed.length;
    mentions = parsed.map((e) => ({
      rawTitle: e.title,
      rawYear: e.year,
      accoladeLabel: `Won: ${opts.awardLabel ?? opts.pageTitle} (${e.year})`,
      skipCandidateExtraction: true,
    }));
  }

  const result = await upsertScrapedArticle(
    {
      sourceId: "wikipedia",
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, "_"))}`,
      title: page.title,
      articleType: "accolade",
      fullText: `${page.title} — ${entriesFound} entries ingested by jellyfin-gate.`,
    },
    mentions,
  );

  return { pageTitle: page.title, entriesFound, matchedCount: result.matchedCount };
}
