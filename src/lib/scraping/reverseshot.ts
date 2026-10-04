import "server-only";

import * as cheerio from "cheerio";

import { logEvent, recordExternalApiCall } from "../events";
import { upsertScrapedArticle, withoutStoredUrls, type FilmMentionInput } from "./articles";

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
/** The site's robots.txt asks for this: "Crawl-delay: 10". */
const REQUEST_DELAY_MS = 10_000;
export const REVERSE_SHOT_REQUEST_DELAY_MS = REQUEST_DELAY_MS;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One page of the site, by path. Exported for critic-lists.ts, which reads the features the same polite way. */
export async function fetchReverseShotHtml(path: string): Promise<string | null> {
  return fetchHtml(path);
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

/** A review's own address: /reviews/entry/{id}/{slug}. Not /reviews/entry/2 (the next page) or /reviews/entry/list. */
const REVIEW_LINK = /\/reviews\/entry\/(\d+)\/([A-Za-z0-9_-]+)/g;
/** The site's index of every review by title: /reviews/entry/list/A … Z, and 0-9. */
const INDEX_PAGES = ["0-9", ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"];

/**
 * Review URLs, newest first.
 *
 * A small run reads the front page of /reviews, which is the latest
 * twenty-odd. That was all this ever read, however large a limit it was
 * given: a "new only" refresh asked for everything and still saw one page,
 * so after two months the site's two decades of reviews came to 23 stored.
 * A run that wants more than the front page holds now walks the site's own
 * A–Z index of reviews, 27 pages at the ten seconds robots.txt asks for.
 */
export async function discoverReverseShotReviewUrls(limit = 10): Promise<string[]> {
  const ids = new Map<string, number>();
  const collect = (html: string) => {
    for (const m of html.matchAll(REVIEW_LINK)) ids.set(`${BASE_URL}/reviews/entry/${m[1]}/${m[2]}`, Number(m[1]));
  };
  const newestFirst = () => [...ids.entries()].sort((a, b) => b[1] - a[1]).map(([url]) => url);

  const front = await fetchHtml("/reviews");
  if (front) collect(front);
  if (limit <= ids.size) return newestFirst().slice(0, limit);

  for (const page of INDEX_PAGES) {
    await sleep(REQUEST_DELAY_MS);
    const html = await fetchHtml(`/reviews/entry/list/${page}`);
    if (html) collect(html);
  }
  return newestFirst().slice(0, limit);
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

/** Fetches and stores reviews, newest first — see discoverReverseShotReviewUrls for how far back a run reaches. At ten seconds a review, the whole archive is a job of hours; run it from the scheduler, not a held-open request. */
export async function runReverseShotScrape(limit = 10, onlyNew = false): Promise<ReverseShotRunResult> {
  // A refresh walks the whole listing and keeps only what is not stored yet;
  // see withoutStoredUrls() for why stored articles are left alone.
  const urls = onlyNew
    ? withoutStoredUrls("reverseshot", await discoverReverseShotReviewUrls(Number.MAX_SAFE_INTEGER)).slice(0, limit)
    : await discoverReverseShotReviewUrls(limit);
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
