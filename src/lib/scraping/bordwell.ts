import "server-only";

import * as cheerio from "cheerio";

import { logEvent, recordExternalApiCall } from "../events";
import { upsertScrapedArticle, type FilmMentionInput } from "./articles";

/**
 * David Bordwell's website on cinema (davidbordwell.net) — a film scholar's
 * blog, never scraped before this. robots.txt disallows only the standard
 * WordPress admin/plugin/cache/theme paths plus a couple of unrelated short
 * links; ordinary blog posts and monthly archives are fair game. It also
 * declares `Crawl-delay: 10`, the strictest of any source this codebase
 * scrapes — REQUEST_DELAY_MS below is set to match exactly, not the 1200ms
 * used elsewhere.
 *
 * Real markup, confirmed by fetching a live post rather than guessed: the
 * post title lives in `<title>Observations on film art : {post title}
 * </title>` (the ` : ` separator is consistent), and the body is every
 * `<p>` inside `.entry`.
 *
 * Unlike Bright Wall/Dark Room's explicit `<i>Title</i> (Year)` convention,
 * this blog has no single structured way of naming the film under
 * discussion — many posts are theory essays or multi-film surveys, not
 * single-subject reviews. The one real convention that does hold: Bordwell
 * consistently writes a film's title in ALL CAPS the first time it's named
 * ("...watch THERE WILL BE BLOOD"), so a run of 2+ consecutive capitalised
 * words in the post title is used as the film-title guess when present,
 * falling back to the post title itself otherwise — same graceful-fallback
 * shape as ringer.ts and reverseshot.ts. Expect a real portion of posts to
 * come back "unmatched"; that's inherent to how this blog is written, not a
 * parsing bug, and unmatched mentions sit harmlessly until a curator
 * reviews them (see src/lib/scraping/articles.ts).
 */

const BASE_URL = "https://www.davidbordwell.net";
const USER_AGENT = "jellyfin-gate-curation/1.0 (self-hosted personal media library; single-user, non-commercial)";
/** Matches the site's own declared Crawl-delay: 10 in robots.txt — deliberately not reused from the other adapters' 1200ms. */
const REQUEST_DELAY_MS = 10_000;
const MAX_PAGES = 300;

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
      recordExternalApiCall("davidbordwell", false);
      return null;
    }
    recordExternalApiCall("davidbordwell", true);
    return await res.text();
  } catch (error) {
    recordExternalApiCall("davidbordwell", false);
    logEvent({
      category: "external_api",
      severity: "warning",
      source: "davidbordwell",
      message: `David Bordwell's site request failed: ${path}`,
      detail: { path, error: error instanceof Error ? error.message : String(error) },
    });
    return null;
  }
}

/** Post URLs, walking /blog/page/N/ until a page yields no new links or the safety cap is hit — same shape as brightwalldarkroom.ts's pagination walk. */
export async function discoverBordwellPostUrls(limit = 10): Promise<string[]> {
  const urls = new Set<string>();

  for (let page = 1; page <= MAX_PAGES && urls.size < limit; page++) {
    const html = await fetchHtml(page === 1 ? "/blog/" : `/blog/page/${page}/`);
    if (page > 1) await sleep(REQUEST_DELAY_MS);
    if (!html) break;

    const $ = cheerio.load(html);
    const before = urls.size;
    $("a[href*='davidbordwell.net/blog/']").each((_, el) => {
      const href = $(el).attr("href");
      if (!href) return;
      if (!/davidbordwell\.net\/blog\/\d{4}\/\d{2}\/\d{2}\/[^/]+\/?$/.test(href)) return;
      // The site's own internal links are consistently http://, not https://,
      // even though the site itself serves fine over https — normalise so
      // runBordwellScrape's BASE_URL-based path stripping actually matches
      // instead of silently building a malformed double-origin URL.
      urls.add(href.replace(/^http:\/\//, "https://"));
    });
    if (urls.size === before) break;
  }

  return [...urls].slice(0, limit);
}

/** A run of 2+ consecutive ALL-CAPS words — the blog's own convention for naming a film in running text. Ignores short connector-only runs ("A THE") by requiring at least one word of 3+ letters. */
function extractCapsTitle(text: string): string | null {
  const match = text.match(/\b([A-Z][A-Z''-]{1,}(?:\s+[A-Z][A-Z''-]{1,}){1,})\b/);
  if (!match?.[1]) return null;
  const words = match[1].split(/\s+/);
  if (!words.some((w) => w.length >= 3)) return null;
  return words.map((w) => w[0] + w.slice(1).toLowerCase()).join(" ");
}

export interface ParsedBordwellPost {
  headline: string;
  filmTitle: string;
  bodyText: string;
}

export function parseBordwellPost(html: string): ParsedBordwellPost | null {
  const $ = cheerio.load(html);

  const rawTitle = $("title").first().text().trim();
  const headline = rawTitle.includes(" : ") ? rawTitle.split(" : ").slice(1).join(" : ").trim() : rawTitle;
  if (!headline) return null;

  const bodyText = $(".entry p")
    .toArray()
    .map((el) => $(el).text().replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n\n");
  if (!bodyText) return null;

  const filmTitle = extractCapsTitle(headline) ?? headline;

  return { headline, filmTitle, bodyText };
}

export interface BordwellRunResult {
  postsProcessed: number;
  matchedCount: number;
}

export async function runBordwellScrape(limit = 10): Promise<BordwellRunResult> {
  const urls = await discoverBordwellPostUrls(limit);
  let postsProcessed = 0;
  let matchedCount = 0;

  for (const url of urls) {
    const path = url.replace(BASE_URL, "");
    const html = await fetchHtml(path);
    await sleep(REQUEST_DELAY_MS);
    if (!html) continue;

    const parsed = parseBordwellPost(html);
    if (!parsed) continue;

    const mentions: FilmMentionInput[] = [{ rawTitle: parsed.filmTitle, rawYear: null }];

    const result = await upsertScrapedArticle(
      {
        sourceId: "davidbordwell",
        url,
        title: parsed.headline,
        articleType: "review",
        fullText: parsed.bodyText,
      },
      mentions,
    );

    postsProcessed++;
    matchedCount += result.matchedCount;
  }

  return { postsProcessed, matchedCount };
}
