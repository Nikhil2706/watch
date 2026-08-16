import "server-only";

import { logEvent, recordExternalApiCall } from "../events";
import { upsertScrapedArticle, type FilmMentionInput } from "./articles";

/**
 * Wikipedia via the official MediaWiki REST API — never HTML scraping.
 * Their own robots.txt/Terms explicitly prefer this route, and content is
 * CC-BY-SA, "freely reusable by anyone" with attribution.
 *
 * Entry point is per-film (given a library title/year/imdb_id, go find its
 * Wikipedia page), not a crawl — Wikipedia film pages are single-subject,
 * so there is no multi-film matching problem here the way there is for a
 * listicle or a book.
 */

const API_BASE = "https://en.wikipedia.org/w/rest.php/v1";
// Wikipedia's own guidance asks bots to identify themselves with a contact
// point, not just a generic fetch UA.
const USER_AGENT = "jellyfin-gate-curation/1.0 (self-hosted personal media library; single-user, non-commercial)";

interface SearchResult {
  pages: Array<{ title: string; description?: string | null }>;
}

export interface PageSource {
  title: string;
  source: string;
}

async function wikiFetch<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      // 404 is routine here — most search misses land as an empty result set,
      // not a 404 — so only genuinely unexpected statuses count as a failure.
      recordExternalApiCall("wikipedia", res.status === 404);
      return null;
    }
    recordExternalApiCall("wikipedia", true);
    return (await res.json()) as T;
  } catch (error) {
    recordExternalApiCall("wikipedia", false);
    logEvent({
      category: "external_api",
      severity: "warning",
      source: "wikipedia",
      message: `Wikipedia API request failed: ${path}`,
      detail: { path, error: error instanceof Error ? error.message : String(error) },
    });
    return null;
  }
}

async function findFilmPageTitle(title: string, year: number | null): Promise<string | null> {
  const query = year ? `${title} ${year} film` : `${title} film`;
  const result = await wikiFetch<SearchResult>(`/search/page?q=${encodeURIComponent(query)}&limit=5`);
  if (!result || result.pages.length === 0) return null;

  // Prefer a result Wikipedia's own short description calls a film — the
  // plain title search alone tends to surface disambiguation or unrelated
  // pages sharing the same words.
  const filmMatch = result.pages.find((p) => p.description?.toLowerCase().includes("film"));
  return (filmMatch ?? result.pages[0])?.title ?? null;
}

async function fetchPageSource(pageTitle: string): Promise<PageSource | null> {
  return wikiFetch<PageSource>(`/page/${encodeURIComponent(pageTitle)}`);
}

/** Same fetch, exposed for a caller that already knows the exact page title (a list/awards page, not a film search) — see wikipedia-lists.ts. */
export async function fetchWikipediaPageByTitle(pageTitle: string): Promise<PageSource | null> {
  return fetchPageSource(pageTitle);
}

// --- wikitext -> plain text -------------------------------------------

export function stripWikitext(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<ref[^>]*\/>/gi, "")
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, "")
    .replace(/\{\{[^{}]*\}\}/g, "") // simple (non-nested) templates
    .replace(/\[\[[^[\]|]*\|([^[\]]*)\]\]/g, "$1") // [[Link|Display]] -> Display
    .replace(/\[\[([^[\]]*)\]\]/g, "$1") // [[Link]] -> Link
    .replace(/\[https?:\/\/\S+\s+([^\]]*)\]/g, "$1") // [http://... text] -> text
    .replace(/\[https?:\/\/\S+\]/g, "")
    .replace(/'''''/g, "")
    .replace(/'''/g, "")
    .replace(/''/g, "")
    .replace(/^={2,5}\s*(.+?)\s*={2,5}$/gm, "$1") // ===Subheading=== -> Subheading (a level-2 section can carry ===/==== subsections; only the level-2 boundary itself is stripped as a heading elsewhere, not these)
    .replace(/<[^>]+>/g, "")
    .replace(/[ \t]+/g, " ")
    .trim();
}

/** The text of one `== Heading ==` section (level 2), up to the next level-2 heading. */
function extractSection(wikitext: string, headingNames: string[]): string | null {
  const pattern = new RegExp(
    `^==\\s*(?:${headingNames.map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\s*==\\s*$`,
    "im",
  );
  const start = wikitext.search(pattern);
  if (start === -1) return null;

  const afterHeading = wikitext.slice(start).replace(pattern, "");
  const nextHeading = afterHeading.search(/^==[^=]/m);
  return (nextHeading === -1 ? afterHeading : afterHeading.slice(0, nextHeading)).trim();
}

// --- accolades wikitable parsing (best-effort) -------------------------

export interface ParsedAccoladeEntry {
  rank: number | null;
  label: string;
}

/**
 * Heuristic wikitable parser scoped to the common "Award | Category |
 * Recipient(s) | Result" shape. Real pages vary — merged cells via rowspan
 * (not tracked here, so a spanned award name only attaches to its first
 * row), extra columns, nested templates — so this is expected to need
 * refinement once run against real pages (Stage 5 testing), not a general
 * wikitext table parser.
 */
export function parseAccoladesSection(wikitext: string): ParsedAccoladeEntry[] {
  const section = extractSection(wikitext, ["Accolades", "Awards and nominations", "Awards"]);
  if (!section) return [];

  const entries: ParsedAccoladeEntry[] = [];
  const tables = section.match(/\{\|[\s\S]*?\n\|\}/g) ?? [];

  for (const table of tables) {
    const rows = table.split(/\n\|-/).slice(1);
    for (const row of rows) {
      const cells = row
        .split(/\n[!|]|\|\|/)
        .map((c) => stripWikitext(c.replace(/^[!|]/, "")))
        .filter((c) => c.length > 0);
      if (cells.length < 2) continue;

      const resultCell = cells.find((c) => /\bwon\b/i.test(c) || /\bnominated\b/i.test(c) || /\bnominee\b/i.test(c));
      if (!resultCell) continue;

      const isWin = /\bwon\b/i.test(resultCell);
      const descriptive = cells.filter((c) => c !== resultCell);
      const label = `${isWin ? "Won" : "Nominated"}: ${descriptive.slice(0, 2).join(", ")}`.trim();
      if (descriptive.length > 0) entries.push({ rank: null, label });
    }
  }

  return entries;
}

/** Production/background prose is the actual trivia source — Wikipedia has no dedicated "Trivia" heading by editorial convention. */
export function extractTriviaWindow(wikitext: string): string | null {
  const section = extractSection(wikitext, ["Production", "Background", "Development"]);
  return section ? stripWikitext(section) : null;
}

export interface WikipediaFetchResult {
  found: boolean;
  articleId?: string;
  accoladeCount?: number;
}

/**
 * Fetches and stores a library film's Wikipedia page: one article_film_links
 * row carrying the film's blurb/trivia candidates (from Production/
 * Background prose), plus one additional row per parsed accolade result
 * (win or nomination — these carry no candidates of their own, see
 * skipCandidateExtraction on FilmMentionInput).
 */
export async function fetchWikipediaForFilm(
  title: string,
  year: number | null,
  imdbId: string,
): Promise<WikipediaFetchResult> {
  const pageTitle = await findFilmPageTitle(title, year);
  if (!pageTitle) return { found: false };

  const page = await fetchPageSource(pageTitle);
  if (!page) return { found: false };

  const accolades = parseAccoladesSection(page.source);
  const triviaWindow = extractTriviaWindow(page.source);
  // The "window" for the primary mention is the trivia prose when present,
  // else the whole article — either way this is what blurb/trivia
  // candidates get extracted from for this film specifically (a Wikipedia
  // page has no other film to confuse it with, so no real windowing needed
  // beyond preferring the prose section over infobox/table noise).
  const primaryWindow = triviaWindow ?? stripWikitext(page.source);

  const mentions: Array<FilmMentionInput & { window?: string }> = [
    { rawTitle: title, rawYear: year },
    ...accolades.map((a) => ({
      rawTitle: title,
      rawYear: year,
      accoladeRank: a.rank,
      accoladeLabel: a.label,
      skipCandidateExtraction: true,
    })),
  ];

  // upsertScrapedArticle windows every mention off fullText itself via
  // windowTextAroundMention; passing the already-cleaned prose as fullText
  // (rather than raw wikitext) keeps blurb/trivia candidates readable, at
  // the cost of the accolades table no longer being present in fullText —
  // acceptable, since the accolades are already parsed and stored as their
  // own link rows, not left for the curator to re-discover in the raw text.
  const result = await upsertScrapedArticle(
    {
      sourceId: "wikipedia",
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, "_"))}`,
      title: page.title,
      articleType: "accolade",
      fullText: primaryWindow,
    },
    mentions,
  );

  void imdbId; // matchTitle() re-derives the same imdb_id from title/year; kept as a documented parameter for callers that already know it.

  return { found: true, articleId: result.articleId, accoladeCount: accolades.length };
}
