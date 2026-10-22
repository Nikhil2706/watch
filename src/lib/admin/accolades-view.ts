/**
 * The Accolades tab's data shaping (step 2e of moving the console). Ported
 * from curator.html (ACC_FILTERS, accWeight, accPassageScore, the film
 * pane's mentions, the rich-text toolbar, the sources and the builder); no
 * React, so it can be tested.
 */

export interface AccFilm {
  imdbId: string;
  name: string;
  year: number | null;
  posterUrl: string | null;
  articles: number;
  blurbCandidates: number;
  triviaCandidates: number;
  hasMaterial: boolean;
  curated: boolean;
  blurbChosen: boolean;
  triviaChosen: number;
  accoladeChosen: boolean;
}

export const ACC_FILTERS = [
  { key: "material", label: "Material waiting", test: (f: AccFilm) => f.hasMaterial && !f.curated },
  { key: "blurb", label: "Blurb chosen", test: (f: AccFilm) => f.blurbChosen },
  { key: "trivia", label: "Trivia chosen", test: (f: AccFilm) => f.triviaChosen > 0 },
  { key: "accolade", label: "Has an accolade", test: (f: AccFilm) => f.accoladeChosen },
  { key: "all", label: "Everything", test: () => true },
] as const;

export type AccFilter = (typeof ACC_FILTERS)[number]["key"];

/** How much there is to read for a film: what "most material first" sorts on. */
export function accWeight(f: Pick<AccFilm, "articles" | "blurbCandidates" | "triviaCandidates">): number {
  return f.articles * 100 + f.blurbCandidates + f.triviaCandidates;
}

/** The rail shows at most this many; narrow it with search or a chip. */
export const RAIL_CAP = 200;

export function visibleFilms(films: readonly AccFilm[], filter: AccFilter, query: string, sort: "material" | "name"): AccFilm[] {
  const f = ACC_FILTERS.find((x) => x.key === filter) ?? ACC_FILTERS[0];
  const q = query.trim().toLowerCase();
  const rows = films.filter((film) => f.test(film) && (!q || film.name.toLowerCase().includes(q) || String(film.year ?? "").includes(q)));
  return sort === "name" ? rows.sort((a, b) => a.name.localeCompare(b.name)) : rows.sort((a, b) => accWeight(b) - accWeight(a) || a.name.localeCompare(b.name));
}

export function accChips(films: readonly AccFilm[], on: AccFilter): Array<{ key: AccFilter; label: string; count: number; on: boolean }> {
  return ACC_FILTERS.map((f) => ({ key: f.key, label: f.label, count: films.filter(f.test).length, on: f.key === on }));
}

export function railLine(f: AccFilm): { sub: string; dot: "accent" | "warn" | "" } {
  if (f.curated) return { sub: "done", dot: "accent" };
  if (f.hasMaterial) return { sub: `${f.articles} ${f.articles === 1 ? "article" : "articles"}`, dot: "warn" };
  return { sub: "", dot: "" };
}

/** A random film from the best-stocked third of those with material waiting. */
export function surprisePick(films: readonly AccFilm[], random: () => number = Math.random): AccFilm | null {
  const pool = films.filter((f) => f.hasMaterial && !f.curated).sort((a, b) => accWeight(b) - accWeight(a));
  if (!pool.length) return null;
  const top = pool.slice(0, Math.max(1, Math.ceil(pool.length / 3)));
  return top[Math.floor(random() * top.length)] ?? null;
}

/**
 * How readable a scraped passage is, as a stand-in for how good it is:
 * fragments and whole paragraphs fall away, a line that sits under a poster
 * scores highest.
 */
export function passageScore(text: string | null | undefined): number {
  const n = (text ?? "").trim().length;
  if (n < 40) return n;
  if (n <= 240) return 1000 - Math.abs(150 - n);
  return Math.max(0, 700 - (n - 240) / 4);
}

export function bestFirst<T>(items: readonly T[], textOf: (t: T) => string, showAll: boolean, few: number): { shown: T[]; hidden: number } {
  const sorted = [...items].sort((a, b) => passageScore(textOf(b)) - passageScore(textOf(a)));
  const shown = showAll ? sorted : sorted.slice(0, few);
  return { shown, hidden: sorted.length - shown.length };
}

/**
 * Candidates minus those already chosen, with identical passages collapsed:
 * the same sentence is often scraped from several articles, and offering it
 * twice only invites choosing it twice.
 */
export function freshCandidates<T>(items: readonly T[], textOf: (t: T) => string, chosen: readonly string[]): T[] {
  const norm = (t: string) => t.replace(/\s+/g, " ").trim().toLowerCase();
  const seen = new Set(chosen.map(norm));
  const out: T[] = [];
  for (const it of items) {
    const k = norm(textOf(it));
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

export interface Mention {
  kind: "link" | "entry";
  id: string;
  label: string;
  meta: string;
}

export function mentions(
  scraped: ReadonlyArray<{ id: string; accolade_label: string | null; accolade_rank: number | null; article_title: string; source_name: string }>,
  curator: ReadonlyArray<{ id: string; slot: number; accolade_name: string }>,
): Mention[] {
  return [
    ...scraped.map((m) => ({ kind: "link" as const, id: m.id, label: m.accolade_label ? m.accolade_label : `#${m.accolade_rank}`, meta: `${m.article_title} — ${m.source_name}` })),
    ...curator.map((e) => ({ kind: "entry" as const, id: e.id, label: `#${e.slot + 1}`, meta: e.accolade_name })),
  ];
}

export function mentionBadge(label: string): { trophy: boolean; rank: string } {
  const isWin = /^Won/i.test(label);
  const m = label.match(/^#(\d+)/);
  return { trophy: isWin, rank: m ? m[0] : "•" };
}

/* ---- rich text ---------------------------------------------------------- */

/** The tags a blurb or fact may carry; the server re-sanitises on write (src/lib/scraping/rich-text.ts). */
export const RT_TAGS = ["b", "i", "u", "s", "sub", "sup"] as const;

export function sanitizeRichText(input: string): string {
  const allowed = new Set<string>(RT_TAGS);
  return String(input).replace(/<\/?([a-zA-Z0-9]+)[^>]*>/g, (full, rawTag: string) => {
    const tag = rawTag.toLowerCase();
    if (!allowed.has(tag)) return "";
    return full.charAt(1) === "/" ? `</${tag}>` : `<${tag}>`;
  });
}

/** Wraps [start, end) of `value` in a tag; returns the new value and the new selection. */
export function wrapTag(value: string, start: number, end: number, tag: string): { value: string; start: number; end: number } {
  if (start === end) return { value, start, end };
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  const next = value.slice(0, start) + open + value.slice(start, end) + close + value.slice(end);
  return { value: next, start, end: end + open.length + close.length };
}

/* ---- sources ------------------------------------------------------------ */

export const SOURCE_RUN_ROUTES: Record<string, string> = {
  reverseshot: "/api/admin/accolades/run-reverseshot",
  "the-ringer": "/api/admin/accolades/run-ringer",
  brightwalldarkroom: "/api/admin/accolades/run-brightwalldarkroom",
};

export const WIKI_LIST_PRESETS: Record<string, { label: string; body: Record<string, unknown> }> = {
  afi100movies: { label: "AFI's 100 Years...100 Movies (2007)", body: { page_title: "AFI's 100 Years...100 Movies", kind: "ranked", rank_column_hint: "2007" } },
  afi100laughs: { label: "AFI's 100 Years...100 Laughs", body: { page_title: "AFI's 100 Years...100 Laughs", kind: "ranked" } },
  afi100thrills: { label: "AFI's 100 Years...100 Thrills", body: { page_title: "AFI's 100 Years...100 Thrills", kind: "ranked" } },
  oscarsbestpicture: {
    label: "Academy Award for Best Picture",
    body: { page_title: "Academy Award for Best Picture", kind: "winners", award_label: "Academy Award for Best Picture", winners_only: false },
  },
  palmedor: { label: "Palme d'Or", body: { page_title: "Palme d'Or", kind: "winners", award_label: "Palme d'Or, Cannes Film Festival" } },
  goldenlion: { label: "Golden Lion", body: { page_title: "Golden Lion", kind: "winners", award_label: "Golden Lion, Venice Film Festival" } },
};

export function lastJobNote(job: { created_at: number | string; status: string; found_count?: number | null; matched_count?: number | null } | undefined): string {
  if (!job) return "";
  return ` — last run ${new Date(job.created_at).toLocaleDateString()}: ${job.status}${job.found_count != null ? ` (${job.found_count} found, ${job.matched_count} matched)` : ""}`;
}

export function testRunReport(r: { reviewsProcessed?: number; articlesProcessed?: number; matchedCount: number }): string {
  return `Fetched ${r.reviewsProcessed ?? r.articlesProcessed ?? 0} article(s), ${r.matchedCount} matched to library films.`;
}

/* ---- articles browser --------------------------------------------------- */

const PALETTE = ["#5b8def", "#e8935a", "#6fc98a", "#c98ed1", "#e8c85a", "#6ba3c9", "#e8695a", "#8f9cad"];

/** A stable colour per source, in the order sources are first seen. */
export function sourceColours(ids: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of ids) if (!out[id]) out[id] = PALETTE[Object.keys(out).length % PALETTE.length]!;
  return out;
}

export function sourceBar(s: { article_count: number; matched_count: number }, max: number): { width: number; matched: number } {
  const width = Math.max(2, Math.round((s.article_count / Math.max(1, max)) * 100));
  const matched = s.article_count ? Math.round((s.matched_count / s.article_count) * width) : 0;
  return { width, matched };
}

export function browseQuery(q: string, source: string, matched: string, offset: number): string {
  const p = new URLSearchParams();
  if (q) p.set("q", q);
  if (source) p.set("source", source);
  if (matched) p.set("matched", matched);
  p.set("offset", String(offset));
  return `/api/admin/accolades/browse?${p.toString()}`;
}

/** The reader's body as paragraphs (blank-line separated), so a selection can be placed per line. */
export function paragraphs(body: string | null | undefined): string[] {
  return String(body ?? "").split("\n\n");
}

/* ---- builder ------------------------------------------------------------ */

/**
 * A saved row edits its rank in place; a new row enters at a position and
 * pushes the rest down (inserting by position is what stopped a new entry
 * overwriting whatever held that rank).
 */
export function slotBody(input: { title: string; blurb: string; imdbId: string | null; year: number | null; slot: number | null; insertAt: number | null }): Record<string, unknown> | { error: string } {
  const title = input.title.trim();
  if (!title) return { error: "Title required." };
  const body: Record<string, unknown> = { title, blurb_text: input.blurb.trim() || null };
  if (input.imdbId) {
    body.imdb_id = input.imdbId;
    if (input.year) body.year = input.year;
  }
  if (input.insertAt !== null) body.insert_at = input.insertAt;
  else body.slot = input.slot;
  return body;
}
