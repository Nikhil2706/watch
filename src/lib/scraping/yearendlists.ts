import "server-only";

import * as cheerio from "cheerio";

import { logEvent, recordExternalApiCall } from "../events";
import { upsertScrapedArticle, type FilmMentionInput } from "./articles";

/**
 * yearendlists.com — an index of OTHER publications' year-end film lists
 * ("we make no tallies"). robots.txt only disallows /search; everything
 * else, including /category/ pages and individual list pages, is fair
 * game. No blurb text lives on this site itself (lists here are rank +
 * title + director, linking out to the original source for commentary),
 * so every entry lands as a plain ranked accolade mention with no blurb/
 * trivia candidates of its own.
 *
 * Selectors below were reverse-engineered against real fetched pages this
 * session, not guessed — see the CSS class names, which match the site's
 * actual (if oddly book-flavored: "book-title", "book-author") markup.
 */

const BASE_URL = "https://www.yearendlists.com";
const USER_AGENT = "jellyfin-gate-curation/1.0 (self-hosted personal media library; single-user, non-commercial)";
// Politeness: this is a small, single-maintainer site with no paid infra
// behind it (the site's own footer says as much) — space requests out.
const REQUEST_DELAY_MS = 1200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchHtml(path: string): Promise<string | null> {
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      // 404 is routine (a category page can simply run out of pages), so only
      // count genuinely unexpected statuses as a failure worth flagging.
      recordExternalApiCall("yearendlists", res.status === 404);
      return null;
    }
    recordExternalApiCall("yearendlists", true);
    return await res.text();
  } catch (error) {
    recordExternalApiCall("yearendlists", false);
    logEvent({
      category: "external_api",
      severity: "warning",
      source: "yearendlists",
      message: `yearendlists.com request failed: ${path}`,
      detail: { path, error: error instanceof Error ? error.message : String(error) },
    });
    return null;
  }
}

/**
 * Discovers list-page URLs from a year's movies category, following
 * pagination up to maxPages. Scoped to `.graphical-posts .graphical-post`
 * specifically — the category page also carries a site-wide nav widget and
 * a cross-category "other lists" sidebar that link to non-movie lists
 * (books, albums), and a looser `a[href^="/2025/"]` selector picks those up
 * too.
 */
export async function discoverYearendlistsUrls(year: number, maxPages = 3): Promise<string[]> {
  const urls = new Set<string>();
  let path: string | null = `/category/${year}-movies`;
  let page = 0;

  while (path && page < maxPages) {
    const html = await fetchHtml(path);
    if (!html) break;
    const $ = cheerio.load(html);

    $(".graphical-posts .graphical-post a[href^='/']").each((_, el) => {
      const href = $(el).attr("href");
      if (href) urls.add(href);
    });

    const next = $("a.pagination-icon-link[rel='next']").attr("href");
    path = next ?? null;
    page++;
    if (path) await sleep(REQUEST_DELAY_MS);
  }

  return [...urls];
}

export interface ParsedListEntry {
  rank: number;
  title: string;
}

export interface ParsedList {
  listTitle: string;
  entries: ParsedListEntry[];
}

export function parseListPage(html: string): ParsedList | null {
  const $ = cheerio.load(html);
  const listTitle = $(".post-header h2").first().text().trim();
  if (!listTitle) return null;

  const entries: ParsedListEntry[] = [];
  $("ol > li[value]").each((_, li) => {
    const $li = $(li);
    const rank = Number($li.attr("value"));
    const title = $li.find(".book-title a").first().text().trim();
    if (Number.isFinite(rank) && title) entries.push({ rank, title });
  });

  return entries.length > 0 ? { listTitle, entries } : null;
}

export interface YearendlistsRunResult {
  listsProcessed: number;
  entriesFound: number;
  matchedCount: number;
}

/**
 * Full run: discover this year's movie lists, fetch and parse each, store
 * every entry as a ranked accolade mention. Every list becomes its own
 * scraped_articles row (url = the list's own page), so re-running is a
 * normal upsert per list, not a giant merge.
 */
export async function runYearendlistsScrape(year: number, maxPages = 3): Promise<YearendlistsRunResult> {
  const urls = await discoverYearendlistsUrls(year, maxPages);
  let listsProcessed = 0;
  let entriesFound = 0;
  let matchedCount = 0;

  for (const path of urls) {
    const html = await fetchHtml(path);
    await sleep(REQUEST_DELAY_MS);
    if (!html) continue;

    const parsed = parseListPage(html);
    if (!parsed) continue;

    const mentions: FilmMentionInput[] = parsed.entries.map((e) => ({
      rawTitle: e.title,
      rawYear: year,
      accoladeRank: e.rank,
      // No prose on this source to extract a blurb/trivia window from.
      skipCandidateExtraction: true,
    }));

    const result = await upsertScrapedArticle(
      {
        sourceId: "yearendlists",
        url: `${BASE_URL}${path}`,
        title: parsed.listTitle,
        articleType: "accolade",
        fullText: parsed.entries.map((e) => `${e.rank}. ${e.title}`).join("\n"),
      },
      mentions,
    );

    listsProcessed++;
    entriesFound += parsed.entries.length;
    matchedCount += result.matchedCount;
  }

  return { listsProcessed, entriesFound, matchedCount };
}
