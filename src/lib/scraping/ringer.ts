import "server-only";

import * as cheerio from "cheerio";

import { logEvent, recordExternalApiCall } from "../events";
import { upsertScrapedArticle, type FilmMentionInput } from "./articles";

/**
 * The Ringer (theringer.com) — a movie/TV/sports/culture site; per your
 * request, filtered down to movies specifically, and further to actual
 * single-film REVIEWS (not oral histories, rankings, or "best of" lists,
 * which don't carry a single film title to match against). robots.txt only
 * disallows /api/ and /_next/data/ — article pages and /topic/movies are
 * fair game.
 *
 * Real markup, confirmed by fetching live pages rather than guessed:
 * a review's headline lives in `<h1>`, the byline in an `<a aria-label="Go
 * to {author}'s page">`, and the body in `<p data-sentry-source-file=
 * "paragraph.tsx">` — that data-sentry attribute is a build-tool artifact
 * far more stable than the surrounding Tailwind utility classes, which
 * churn on every deploy.
 *
 * The film being reviewed is NOT reliably in the headline (real examples:
 * `'The End of Oak Street' Is All Bite` has it quoted, but `Steven
 * Spielberg Is Still Searching for Truth` — a review of "Disclosure Day"
 * — doesn't mention the title at all). The URL slug is far more
 * consistent: every review URL is `/YYYY/MM/DD/movies/{film-slug}-review-
 * {other stuff}`, and the part before "-review-" is the film title with
 * hyphens for spaces — confirmed against four real review URLs, all four
 * matched (including one, "I Love Boosters", that also happened to be
 * separately confirmable via its quoted headline).
 */

const BASE_URL = "https://www.theringer.com";
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
      recordExternalApiCall("ringer", false);
      return null;
    }
    recordExternalApiCall("ringer", true);
    return await res.text();
  } catch (error) {
    recordExternalApiCall("ringer", false);
    logEvent({
      category: "external_api",
      severity: "warning",
      source: "ringer",
      message: `The Ringer request failed: ${path}`,
      detail: { path, error: error instanceof Error ? error.message : String(error) },
    });
    return null;
  }
}

/** Movie REVIEW URLs from the /topic/movies listing — same "one listing page, no pagination crawl" scope as reverseshot.ts. */
export async function discoverRingerReviewUrls(limit = 10): Promise<string[]> {
  const html = await fetchHtml("/topic/movies");
  if (!html) return [];
  const $ = cheerio.load(html);

  const urls = new Set<string>();
  $("a[href*='/movies/']").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    // /YYYY/MM/DD/movies/{slug}-review-... — the movies-only + reviews-only filter.
    if (!/^\/\d{4}\/\d{2}\/\d{2}\/movies\/.+-review-/.test(href)) return;
    urls.add(href.startsWith("http") ? href : `${BASE_URL}${href}`);
  });

  return [...urls].slice(0, limit);
}

function slugToTitle(url: string): string | null {
  const match = url.match(/\/movies\/([^/]+)-review-/);
  if (!match?.[1]) return null;
  return match[1]
    .split("-")
    .map((w) => (w.length > 0 ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(" ");
}

export interface ParsedRingerReview {
  headline: string;
  author: string | null;
  filmTitle: string;
  bodyText: string;
}

export function parseRingerReview(html: string, url: string): ParsedRingerReview | null {
  const $ = cheerio.load(html);

  const headline = $("h1").first().text().trim();
  if (!headline) return null;

  const author = $("a[aria-label^='Go to']").first().attr("aria-label")?.match(/^Go to (.+?)'s page$/)?.[1] ?? null;

  const bodyText = $("p[data-sentry-source-file='paragraph.tsx']")
    .toArray()
    .map((el) => $(el).text().replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n\n");
  if (!bodyText) return null;

  const filmTitle = slugToTitle(url) ?? headline;

  return { headline, author, filmTitle, bodyText };
}

export interface RingerRunResult {
  reviewsProcessed: number;
  matchedCount: number;
}

export async function runRingerScrape(limit = 10): Promise<RingerRunResult> {
  const urls = await discoverRingerReviewUrls(limit);
  let reviewsProcessed = 0;
  let matchedCount = 0;

  for (const url of urls) {
    const path = url.replace(BASE_URL, "");
    const html = await fetchHtml(path);
    await sleep(REQUEST_DELAY_MS);
    if (!html) continue;

    const parsed = parseRingerReview(html, url);
    if (!parsed) continue;

    const mentions: FilmMentionInput[] = [{ rawTitle: parsed.filmTitle, rawYear: null }];

    const result = await upsertScrapedArticle(
      {
        sourceId: "the-ringer",
        url,
        title: parsed.headline,
        articleType: "review",
        fullText: parsed.bodyText,
      },
      mentions,
    );

    reviewsProcessed++;
    matchedCount += result.matchedCount;
  }

  return { reviewsProcessed, matchedCount };
}
