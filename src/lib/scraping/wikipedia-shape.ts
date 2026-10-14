/**
 * Reading what the Wikipedia REST API actually sends, not what it usually
 * sends.
 *
 * wikipedia.ts cast both responses straight to their happy-path types, so a
 * search with `pages: null`, a result with a null title, or a page whose
 * `source` or `title` is null went through as if it were whole and threw a
 * TypeError further in. The backfill records a throw as a failed job, so the
 * same films failed every night and kept the Health tab on "warning".
 * Anything not usable here is "no article": the film is recorded as having
 * none rather than failing.
 *
 * No imports, so it is tested directly (wikipedia-shape.test.ts).
 */

export interface SearchHit {
  title: string;
  description: string | null;
}

export interface PageSource {
  title: string;
  source: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** The usable hits of a /search/page response: each with a title. Empty for anything else. */
export function readSearchHits(json: unknown): SearchHit[] {
  if (!isObject(json) || !Array.isArray(json.pages)) return [];
  const hits: SearchHit[] = [];
  for (const page of json.pages) {
    if (!isObject(page)) continue;
    const title = nonEmptyString(page.title);
    if (!title) continue;
    hits.push({ title, description: typeof page.description === "string" ? page.description : null });
  }
  return hits;
}

/**
 * The film's page among the hits: the first one Wikipedia's own short
 * description calls a film (a plain title search tends to surface
 * disambiguation or unrelated pages sharing the words), else the first.
 */
export function pickFilmPageTitle(hits: SearchHit[]): string | null {
  const film = hits.find((h) => h.description?.toLowerCase().includes("film"));
  return (film ?? hits[0])?.title ?? null;
}

/** A /page/{title} response with both a title and wikitext, or null. */
export function readPageSource(json: unknown): PageSource | null {
  if (!isObject(json)) return null;
  const title = nonEmptyString(json.title);
  const source = nonEmptyString(json.source);
  return title && source ? { title, source } : null;
}
