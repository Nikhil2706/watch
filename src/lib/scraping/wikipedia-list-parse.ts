/**
 * Reads the tables of a Wikipedia list page: a ranked list ("AFI's 100
 * Years…100 Thrills"), or an award's winners year by year, with or without
 * the nominees beside them. Pure, so it can be tested; wikipedia-lists.ts
 * fetches the page and stores what this finds.
 *
 * The first parsers (still in wikipedia-lists.ts, still tried first for the
 * four pages they were written against) each knew one table: cells joined by
 * "||" on one line with the rank last, or the year in a "!" header cell.
 * Most pages are laid out otherwise. Checked against the wikitext of
 * nineteen real pages on 2026-10-04, these are the variations that matter:
 *
 *   - one cell per line, or several on a line joined by "||", or by <td>;
 *   - rows divided by "|-", or (the BBC's list) not divided at all;
 *   - the year in a "!" cell, or in an ordinary cell with a rowspan, or in an
 *     ordinary cell with nothing to mark it but being a year;
 *   - the winner marked by a background colour, by bold, or not marked at
 *     all because the page lists winners only.
 */

export interface WikiCell {
  header: boolean;
  /** `style="…" rowspan="7"` — whatever stood before the cell's own text. */
  attrs: string;
  text: string;
}

/** Every `{| … |}` table on the page, outermost only. */
export function wikiTables(wikitext: string): string[] {
  return wikitext.match(/\{\|[\s\S]*?\n\|\}/g) ?? [];
}

/** Splits on `separator` wherever it is not inside [[…]] or {{…}}. */
function splitOutside(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const two = text.slice(i, i + 2);
    if (two === "[[" || two === "{{") {
      depth++;
      i++;
    } else if (two === "]]" || two === "}}") {
      depth = Math.max(0, depth - 1);
      i++;
    } else if (depth === 0 && text.startsWith(separator, i)) {
      parts.push(text.slice(start, i));
      i += separator.length - 1;
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

function toCell(raw: string, header: boolean): WikiCell {
  // `style="…" | text`: one bar, outside any link or template, with
  // something that reads as attributes before it.
  const bar = splitOutside(raw, "|");
  if (bar.length >= 2 && /^[\s\w-]+=/.test(bar[0]!.trim())) {
    return { header, attrs: bar[0]!.trim(), text: bar.slice(1).join("|").trim() };
  }
  return { header, attrs: "", text: raw.trim() };
}

/** The rows of one table, header rows included, as cells. */
export function wikiRows(table: string): WikiCell[][] {
  const lines = table
    .replace(/<\/t[dr]>/gi, "")
    .replace(/<td[^>]*>/gi, "||")
    .split("\n")
    .slice(1);
  const divided = lines.some((l) => l.startsWith("|-"));
  const rows: WikiCell[][] = [];
  let row: WikiCell[] = [];
  const close = () => {
    if (row.length > 0) rows.push(row);
    row = [];
  };

  for (const line of lines) {
    if (line.startsWith("|}")) break;
    if (line.startsWith("|-")) {
      close();
      continue;
    }
    if (line.startsWith("|+")) continue;
    const header = line.startsWith("!");
    if (!header && !line.startsWith("|")) {
      // A cell's text running on to another line.
      const last = row[row.length - 1];
      if (last) last.text = `${last.text}\n${line}`.trim();
      continue;
    }
    // Without "|-" between them, every line of cells is a row of its own.
    if (!divided && !header) close();
    const body = line.slice(1);
    const parts = header ? splitOutside(body, "!!").flatMap((p) => splitOutside(p, "||")) : splitOutside(body, "||");
    for (const part of parts) row.push(toCell(part, header));
    if (!divided && header) close();
  }
  close();
  return rows;
}

/** A cell as a reader sees it: links by their display text, templates and markup gone. */
export function wikiDisplay(text: string): string {
  let out = text
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<ref[^>]*\/>/gi, "")
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, "")
    .replace(/<br\s*\/?>/gi, " ");
  // Templates that only wrap their text: keep the text.
  for (let i = 0; i < 4; i++) {
    out = out
      .replace(/\{\{\s*(?:center|small|nowrap|nobr|nobold|big)\s*\|([^{}]*)\}\}/gi, "$1")
      .replace(/\{\{\s*sort(?:name)?\s*\|[^|{}]*\|([^{}]*)\}\}/gi, "$1");
  }
  return out
    .replace(/\{\{[^{}]*\}\}/g, "")
    .replace(/\[\[[^[\]|]*\|([^[\]]*)\]\]/g, "$1")
    .replace(/\[\[([^[\]]*)\]\]/g, "$1")
    .replace(/'{2,}/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/[†‡±§*]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The film a cell names. A film's title is set in italics, which is what
 * tells its cell from the director's or the country's beside it; the title
 * itself is what the cell's first link displays (the italics are as often
 * inside the link as around it), or the italic text when nothing is linked.
 */
function filmIn(cell: WikiCell): string | null {
  if (!/''/.test(cell.text)) return null;
  const link = /\[\[([^[\]|]+)(?:\|([^[\]]+))?\]\]/.exec(cell.text);
  const italic = /''+((?:[^'\n]|'(?!'))+?)''+/.exec(cell.text.replace(/\{\{\s*sort\s*\|[^|{}]*\|/gi, ""));
  const title = wikiDisplay(link ? (link[2] ?? link[1]!) : (italic?.[1] ?? ""));
  return title.length > 0 && title.length <= 120 ? title : null;
}

/** A cell that is a year and nothing more than a year: "2010", "1950 (4th)", "1927/28". */
function yearOf(cell: WikiCell): number | null {
  if (/''[^']/.test(cell.text) && !/'''/.test(cell.text)) return null; // italics: a title, perhaps "1917"
  const shown = wikiDisplay(cell.text);
  const m = /^\(?(1[89]\d{2}|20\d{2})\b/.exec(shown);
  if (!m) return null;
  // What follows the year may be an ordinal or a second year, not a title.
  const rest = shown.slice(m[0].length).trim();
  if (rest.length > 0 && !/^[\s/–—-]*\d{0,4}\s*(\([^)]*\))?\s*(\[[^\]]*\])?$/.test(rest)) return null;
  return Number(m[1]);
}

export interface RankedEntry {
  rank: number;
  title: string;
  year: number | null;
}

/**
 * A ranked list: the table with a rank column and a film column, whichever
 * order they come in. `rankColumnHint` chooses between several rank columns
 * ("2007"); without it the last one is used.
 */
export function parseRankedTable(wikitext: string, rankColumnHint?: string): RankedEntry[] {
  let best: RankedEntry[] = [];
  for (const table of wikiTables(wikitext)) {
    const rows = wikiRows(table);
    const headers = rows.filter((r) => r.every((c) => c.header)).flat().map((c) => wikiDisplay(c.text));
    if (headers.length === 0) continue;
    const isRank = (h: string) => /^(#|no\.?|pos(ition|\.)?)$/i.test(h) || /\brank/i.test(h);
    const rankColumns = headers.map((h, i) => ({ h, i })).filter(({ h }) => isRank(h));
    const rankCol = (rankColumnHint ? rankColumns.find(({ h }) => h.includes(rankColumnHint)) : undefined)?.i ?? rankColumns.at(-1)?.i;
    if (rankCol === undefined) continue;

    const entries: RankedEntry[] = [];
    for (const row of rows) {
      if (row.every((c) => c.header)) continue;
      const rank = Number.parseInt(wikiDisplay(row[rankCol]?.text ?? ""), 10);
      const titleCell = row.find((c, i) => i !== rankCol && filmIn(c));
      const title = titleCell ? filmIn(titleCell) : null;
      if (!Number.isFinite(rank) || rank < 1 || !title) continue;
      // The year is whichever other cell is only a year: a rowspan elsewhere
      // in the row can move it out from under its heading.
      const year = row.map((c, i) => (i === rankCol || c === titleCell ? null : yearOf(c))).find((y) => y !== null) ?? null;
      entries.push({ rank, title, year });
    }
    if (entries.length > best.length) best = entries;
  }
  return best.sort((a, b) => a.rank - b.rank);
}

export interface WinnerEntry {
  year: number;
  title: string;
}

/**
 * An award's winners. A row is a winner when the page marks it — a
 * background colour or bold on the title — and when the page marks nothing,
 * every row is one (a page that lists winners only). `winnersOnly: true`
 * says so outright and skips the question.
 */
export function parseWinnersTables(wikitext: string, opts: { winnersOnly?: boolean } = {}): WinnerEntry[] {
  const found: Array<WinnerEntry & { marked: boolean }> = [];

  for (const table of wikiTables(wikitext)) {
    let currentYear: number | null = null;
    for (const row of wikiRows(table)) {
      const first = row[0];
      if (!first) continue;
      const year = yearOf(first);
      const cells = year !== null ? row.slice(1) : row;
      if (year !== null) currentYear = year;
      if (currentYear === null) continue;

      const titleCell = cells.find((c) => !c.header && filmIn(c));
      const title = titleCell ? filmIn(titleCell) : null;
      if (!titleCell || !title) continue;
      const marked = /background/i.test(titleCell.attrs) || /'''/.test(titleCell.text);
      found.push({ year: currentYear, title, marked });
    }
  }

  const anyMarked = found.some((f) => f.marked);
  return found
    .filter((f) => opts.winnersOnly || !anyMarked || f.marked)
    .map(({ year, title }) => ({ year, title }));
}

/** Where a page that has moved now lives: "#REDIRECT [[New title]]". */
export function redirectTarget(wikitext: string): string | null {
  return /^\s*#REDIRECT\s*\[\[([^[\]|#]+)/i.exec(wikitext)?.[1]?.trim() ?? null;
}
