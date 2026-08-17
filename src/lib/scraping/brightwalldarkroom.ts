import "server-only";

import * as cheerio from "cheerio";

import { logEvent, recordExternalApiCall } from "../events";
import { upsertScrapedArticle, type FilmMentionInput } from "./articles";

/**
 * Bright Wall/Dark Room (brightwalldarkroom.com) — a film-essay magazine,
 * cleared for robots.txt (fully open: "Disallow:" for all user agents)
 * before this was ever built.
 *
 * Real markup, confirmed by fetching live pages rather than guessed: a
 * standard WordPress theme, and the cleanest of the three review sites —
 * the film being reviewed is stated explicitly via the site's own
 * consistent `<i>Film Title</i> (Year)` convention, no title-guessing
 * needed at all (unlike reverseshot.ts's "Dir." convention or ringer.ts's
 * slug-parsing). That convention shows up in two places depending on the
 * essay: a dedicated `<p class="subtitle">` under the headline when there
 * is one, or inline inside the `.entry-title` headline itself when there
 * isn't — confirmed against real pages where ONLY checking `.subtitle`
 * missed 6 of 10 real articles, all of which had it inline instead. Author
 * is `.byline-part.author a`, body is `.entry-content p`.
 *
 * NOTE: fetching this site with PowerShell's Invoke-WebRequest gets a 403
 * (some client-fingerprint-based bot block), but plain curl and Node's
 * fetch() both work fine — confirmed the actual robots.txt/ToS impose no
 * such restriction, so this is a client quirk, not a real access rule.
 */

const BASE_URL = "https://www.brightwalldarkroom.com";
const USER_AGENT = "jellyfin-gate-curation/1.0 (self-hosted personal media library; single-user, non-commercial)";
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
      recordExternalApiCall("brightwalldarkroom", false);
      return null;
    }
    recordExternalApiCall("brightwalldarkroom", true);
    return await res.text();
  } catch (error) {
    recordExternalApiCall("brightwalldarkroom", false);
    logEvent({
      category: "external_api",
      severity: "warning",
      source: "brightwalldarkroom",
      message: `Bright Wall/Dark Room request failed: ${path}`,
      detail: { path, error: error instanceof Error ? error.message : String(error) },
    });
    return null;
  }
}

/**
 * Article URLs, walking standard WordPress pagination (/page/2/, /page/3/,
 * ...) rather than just the homepage's first listing — confirmed live at
 * 144 pages deep. Stops when a page yields no new article links (past the
 * real last page WordPress serves the final page's content again rather
 * than a 404, so "no new links" is the reliable stop condition, not the
 * HTTP status) or the safety cap is hit, whichever comes first.
 */
const MAX_PAGES = 200;

export async function discoverBwdrArticleUrls(limit = 10): Promise<string[]> {
  const urls = new Set<string>();

  for (let page = 1; page <= MAX_PAGES && urls.size < limit; page++) {
    const html = await fetchHtml(page === 1 ? "/" : `/page/${page}/`);
    if (page > 1) await sleep(REQUEST_DELAY_MS);
    if (!html) break;

    const $ = cheerio.load(html);
    const before = urls.size;
    $("a[href*='brightwalldarkroom.com/']").each((_, el) => {
      const href = $(el).attr("href");
      if (!href) return;
      if (!/brightwalldarkroom\.com\/\d{4}\/\d{2}\/\d{2}\/[^/]+\/?$/.test(href)) return;
      urls.add(href);
    });
    if (urls.size === before) break;
  }

  return [...urls].slice(0, limit);
}

function decodeCommonEntities(text: string): string {
  return text
    .replace(/&#8217;|&rsquo;/g, "’")
    .replace(/&#8216;|&lsquo;/g, "‘")
    .replace(/&amp;/g, "&")
    .replace(/&#38;/g, "&");
}

/** `<i>Title</i> (Year)` inside a raw HTML fragment — the site's consistent convention for naming the film under review, wherever it appears. */
function extractTitleYear(rawHtml: string | null | undefined): { title: string; year: number } | null {
  if (!rawHtml) return null;
  const match = rawHtml.match(/<i>\s*([^<]+?)\s*<\/i>\s*\((\d{4})\)/);
  if (!match?.[1] || !match[2]) return null;
  return { title: decodeCommonEntities(match[1]).trim(), year: Number.parseInt(match[2], 10) };
}

export interface ParsedBwdrArticle {
  headline: string;
  author: string | null;
  filmTitle: string;
  filmYear: number | null;
  bodyText: string;
}

export function parseBwdrArticle(html: string): ParsedBwdrArticle | null {
  const $ = cheerio.load(html);

  const headline = $(".entry-title").first().text().trim();
  if (!headline) return null;

  const author = $(".byline-part.author a").first().text().trim() || null;

  // The film is consistently `<i>Title</i> (Year)` — sometimes as its own
  // `.subtitle` element ("Rental Family (2025)"), sometimes inline inside
  // the essay's own `.entry-title` itself ("...Lucrecia Martel's <i>Nuestra
  // Tierra</i> (2025)") when the essay has no separate subtitle. Same
  // convention either way, so one extractor covers both — confirmed
  // against real pages where the `.subtitle` path alone missed 6 of 10.
  const extracted = extractTitleYear($(".subtitle").first().html()) ?? extractTitleYear($(".entry-title").first().html());
  const filmTitle = extracted?.title ?? headline;
  const filmYear = extracted?.year ?? null;

  const bodyText = $(".entry-content p")
    .toArray()
    .map((el) => $(el).text().replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n\n");
  if (!bodyText) return null;

  return { headline, author, filmTitle, filmYear, bodyText };
}

export interface BwdrRunResult {
  articlesProcessed: number;
  matchedCount: number;
}

export async function runBwdrScrape(limit = 10): Promise<BwdrRunResult> {
  const urls = await discoverBwdrArticleUrls(limit);
  let articlesProcessed = 0;
  let matchedCount = 0;

  for (const url of urls) {
    const path = url.replace(BASE_URL, "").replace("https://brightwalldarkroom.com", "");
    const html = await fetchHtml(path);
    await sleep(REQUEST_DELAY_MS);
    if (!html) continue;

    const parsed = parseBwdrArticle(html);
    if (!parsed) continue;

    const mentions: FilmMentionInput[] = [{ rawTitle: parsed.filmTitle, rawYear: parsed.filmYear }];

    const result = await upsertScrapedArticle(
      {
        sourceId: "brightwalldarkroom",
        url,
        title: parsed.headline,
        articleType: "review",
        fullText: parsed.bodyText,
      },
      mentions,
    );

    articlesProcessed++;
    matchedCount += result.matchedCount;
  }

  return { articlesProcessed, matchedCount };
}
