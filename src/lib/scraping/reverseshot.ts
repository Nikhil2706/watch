import "server-only";

import * as cheerio from "cheerio";

import { logEvent, recordExternalApiCall } from "../events";
import { upsertScrapedArticle, type FilmMentionInput } from "./articles";

/**
 * Reverse Shot (reverseshot.org, Museum of the Moving Image) — one of the
 * "back pocket" review sites vetted for robots.txt/ToS earlier (only /cms
 * and /message disallowed) but never actually built against until now.
 *
 * Real markup, confirmed by fetching live pages rather than guessed:
 * a review's headline lives in `.article-header h2`, the byline in the
 * `<div>` right after it ("By Author | Date"), and the body in
 * `.article-text p` paragraphs. The film being reviewed isn't always the
 * headline (Reverse Shot headlines are often a stylised phrase, not the
 * plain title) — but the site has its own consistent convention for
 * stating it: the first paragraph that contains "Dir. " also carries the
 * film's title in an `<em>` tag right before it, e.g.
 * `<em>Teenage Sex and Death at Camp Miasma</em><br/>Dir. Jane Schoenbrun, U.S., MUBI`.
 * That's what this parses out and hands to matchTitle().
 */

const BASE_URL = "https://reverseshot.org";
const USER_AGENT = "jellyfin-gate-curation/1.0 (self-hosted personal media library; single-user, non-commercial)";
/** Politeness — same spacing as yearendlists.ts, no published rate limit to respect otherwise. */
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
      recordExternalApiCall("reverseshot", false);
      return null;
    }
    recordExternalApiCall("reverseshot", true);
    return await res.text();
  } catch (error) {
    recordExternalApiCall("reverseshot", false);
    logEvent({
      category: "external_api",
      severity: "warning",
      source: "reverseshot",
      message: `Reverse Shot request failed: ${path}`,
      detail: { path, error: error instanceof Error ? error.message : String(error) },
    });
    return null;
  }
}

/** URLs from the main /reviews listing page — one page's worth, no pagination crawl (kept deliberately small for now). */
export async function discoverReverseShotReviewUrls(limit = 10): Promise<string[]> {
  const html = await fetchHtml("/reviews");
  if (!html) return [];
  const $ = cheerio.load(html);

  const urls = new Set<string>();
  $("a[href*='/reviews/entry/']").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    urls.add(href.startsWith("http") ? href : `${BASE_URL}${href}`);
  });

  return [...urls].slice(0, limit);
}

export interface ParsedReview {
  headline: string;
  author: string | null;
  publishedAt: number | null;
  /** The actual film title, parsed from the "Dir. ..." line when present — falls back to the headline (which is sometimes the plain title anyway, sometimes a stylised phrase). */
  filmTitle: string;
  bodyText: string;
}

export function parseReverseShotReview(html: string): ParsedReview | null {
  const $ = cheerio.load(html);

  const headline = $(".article-header h2").first().text().trim();
  if (!headline) return null;

  const bylineText = $(".article-header > div").first().text().replace(/\s+/g, " ").trim();
  const authorMatch = bylineText.match(/^By\s+(.+?)\s*\|/);
  const author = authorMatch?.[1] ? authorMatch[1].trim() : null;
  const dateMatch = bylineText.match(/\|\s*(.+)$/);
  const parsedDate = dateMatch?.[1] ? Date.parse(dateMatch[1].trim()) : NaN;
  const publishedAt = Number.isFinite(parsedDate) ? parsedDate : null;

  const paragraphs = $(".article-text p").toArray().map((el) => $(el));

  let filmTitle: string | null = null;
  for (const $p of paragraphs) {
    if (/\bDir\.\s/.test($p.text())) {
      const em = $p.find("em").first().text().trim();
      if (em) {
        filmTitle = em;
        break;
      }
    }
  }

  const bodyText = paragraphs
    .map(($p) => $p.text().replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n\n");

  if (!bodyText) return null;

  return { headline, author, publishedAt, filmTitle: filmTitle ?? headline, bodyText };
}

export interface ReverseShotRunResult {
  reviewsProcessed: number;
  matchedCount: number;
}

/** Fetches and stores a small batch of reviews from the listing page — see discoverReverseShotReviewUrls's own comment on why this doesn't paginate yet. */
export async function runReverseShotScrape(limit = 10): Promise<ReverseShotRunResult> {
  const urls = await discoverReverseShotReviewUrls(limit);
  let reviewsProcessed = 0;
  let matchedCount = 0;

  for (const url of urls) {
    const path = url.replace(BASE_URL, "");
    const html = await fetchHtml(path);
    await sleep(REQUEST_DELAY_MS);
    if (!html) continue;

    const parsed = parseReverseShotReview(html);
    if (!parsed) continue;

    const mentions: FilmMentionInput[] = [{ rawTitle: parsed.filmTitle, rawYear: null }];

    const result = await upsertScrapedArticle(
      {
        sourceId: "reverseshot",
        url,
        title: parsed.headline,
        articleType: "review",
        publishedAt: parsed.publishedAt,
        fullText: parsed.bodyText,
      },
      mentions,
    );

    reviewsProcessed++;
    matchedCount += result.matchedCount;
  }

  return { reviewsProcessed, matchedCount };
}
