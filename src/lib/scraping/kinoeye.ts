import "server-only";

import * as cheerio from "cheerio";

import { logEvent, recordExternalApiCall } from "../events";
import { upsertScrapedArticle, type FilmMentionInput } from "./articles";

/**
 * Kinoeye (kinoeye.org) — an online journal of European film published
 * 2001-2004, now a static, unmaintained archive. No robots.txt exists at
 * all (404), so no crawl rules are declared either way; treated with the
 * same politeness delay as the other review sites in the absence of any
 * stricter published rule.
 *
 * The site predates any real API or sitemap, and its own `archive/*.php`
 * "browse by title/director" indexes return a truncated, near-empty
 * response to a plain fetch (confirmed live — 146 bytes, cut off mid-
 * `<head>`, on every archive index tried) — likely a PHP fatal error in
 * code that hasn't been touched since the mid-2000s, not a bot block.
 * Individual per-issue pages (`index_VV_II.php`) work fine and list that
 * issue's articles, so discovery walks a bounded grid of volume/issue
 * numbers rather than relying on the broken indexes.
 *
 * Real markup, confirmed by fetching live pages: `<TITLE>Kinoeye | Country:
 * Original Title (English Title)</TITLE>` (uppercase tag, this site
 * predates HTML5 lowercase conventions) and article body paragraphs inside
 * `<div class="text">`. A handful of individual article pages are
 * themselves broken the same truncated way as the archive indexes (one
 * confirmed live) — treated as an ordinary fetch failure and skipped,
 * same as any other unreachable page.
 */

const BASE_URL = "https://www.kinoeye.org";
const USER_AGENT = "jellyfin-gate-curation/1.0 (self-hosted personal media library; single-user, non-commercial)";
const REQUEST_DELAY_MS = 1200;
/** A response this small is the site's known truncated-PHP-error shape, not a real page — see the file header. */
const MIN_VALID_BYTES = 1000;

const MAX_VOLUME = 5;
const MAX_ISSUE = 24;

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
      recordExternalApiCall("kinoeye", false);
      return null;
    }
    const text = await res.text();
    if (text.length < MIN_VALID_BYTES) {
      // Not a fetch failure — the server answered 200, it just answered
      // with its known truncated-PHP-error page. Still counts as a real
      // (if unsuccessful) call for external API accounting purposes.
      recordExternalApiCall("kinoeye", false);
      return null;
    }
    recordExternalApiCall("kinoeye", true);
    return text;
  } catch (error) {
    recordExternalApiCall("kinoeye", false);
    logEvent({
      category: "external_api",
      severity: "warning",
      source: "kinoeye",
      message: `Kinoeye request failed: ${path}`,
      detail: { path, error: error instanceof Error ? error.message : String(error) },
    });
    return null;
  }
}

/** Article URLs, walking a bounded volume/issue grid via each issue's own index page — see the file header for why this replaces the site's own (broken) archive indexes. */
export async function discoverKinoeyeArticleUrls(limit = 10): Promise<string[]> {
  const urls = new Set<string>();

  outer: for (let vol = 1; vol <= MAX_VOLUME; vol++) {
    for (let issue = 1; issue <= MAX_ISSUE; issue++) {
      if (urls.size >= limit) break outer;

      const vv = String(vol).padStart(2, "0");
      const ii = String(issue).padStart(2, "0");
      const html = await fetchHtml(`/index_${vv}_${ii}.php`);
      await sleep(REQUEST_DELAY_MS);
      if (!html) continue;

      const $ = cheerio.load(html);
      $("a[href$='.php']").each((_, el) => {
        const href = $(el).attr("href");
        if (!href) return;
        if (!/^\d{2}\/\d{2}\/[^/]+\.php$/.test(href)) return;
        urls.add(`${BASE_URL}/${href}`);
      });
    }
  }

  return [...urls].slice(0, limit);
}

export interface ParsedKinoeyeArticle {
  headline: string;
  filmTitle: string;
  bodyText: string;
}

export function parseKinoeyeArticle(html: string): ParsedKinoeyeArticle | null {
  const $ = cheerio.load(html);

  const rawTitle = $("title").first().text().trim();
  if (!rawTitle) return null;

  // "Kinoeye | Country: Original Title (English Title)" — the parenthesised
  // English title is the better match candidate when present; the country
  // prefix before the first colon is dropped either way.
  const afterSite = rawTitle.includes("|") ? rawTitle.split("|").slice(1).join("|").trim() : rawTitle;
  const afterCountry = afterSite.includes(":") ? afterSite.split(":").slice(1).join(":").trim() : afterSite;
  const englishMatch = afterCountry.match(/\(([^)]+)\)\s*$/);
  const filmTitle = englishMatch?.[1]?.trim() || afterCountry;

  const bodyText = $(".text p")
    .toArray()
    .map((el) => $(el).text().replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n\n");
  if (!bodyText) return null;

  return { headline: afterCountry, filmTitle, bodyText };
}

export interface KinoeyeRunResult {
  articlesProcessed: number;
  matchedCount: number;
}

export async function runKinoeyeScrape(limit = 10): Promise<KinoeyeRunResult> {
  const urls = await discoverKinoeyeArticleUrls(limit);
  let articlesProcessed = 0;
  let matchedCount = 0;

  for (const url of urls) {
    const path = url.replace(BASE_URL, "");
    const html = await fetchHtml(path);
    await sleep(REQUEST_DELAY_MS);
    if (!html) continue;

    const parsed = parseKinoeyeArticle(html);
    if (!parsed) continue;

    const mentions: FilmMentionInput[] = [{ rawTitle: parsed.filmTitle, rawYear: null }];

    const result = await upsertScrapedArticle(
      {
        sourceId: "kinoeye",
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
