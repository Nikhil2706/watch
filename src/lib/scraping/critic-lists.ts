import "server-only";

import { asRows, getDb } from "../db";
import { upsertScrapedArticle, type FilmMentionInput } from "./articles";
import { BORDWELL_REQUEST_DELAY_MS, fetchBordwellHtml } from "./bordwell";
import {
  isBordwellTenBestUrl,
  isReverseShotListSlug,
  parseBordwellTenBest,
  parseReverseShotBestOf,
  type ParsedCriticList,
} from "./critic-list-parse";
import { LISTED_PREFIX } from "./resolve";
import { fetchReverseShotHtml, REVERSE_SHOT_REQUEST_DELAY_MS } from "./reverseshot";

/**
 * The lists two of the review sites publish beside their reviews.
 *
 * Reverse Shot runs a "Best of" feature each January: ten films, ranked, a
 * capsule on each by a different writer. On David Bordwell's site Kristin
 * Thompson writes "The ten best films of …" each December about the year
 * ninety years back: ten films, a few paragraphs on each, numbered in the
 * older posts and not in the newer.
 *
 * Both are stored the way The Ringer's lists are (ringer-lists.ts): one
 * scraped_articles row of type "accolade", one mention per film carrying its
 * place and its own paragraphs as passages, so a pick converted from one
 * arrives with its writeups. An unranked entry is labelled "Listed: …"
 * (resolve.ts) rather than given a number its writer never gave it.
 *
 * Unlike The Ringer, which of a site's articles are lists can be told from
 * the address, so only those are opened. Finding the addresses still means
 * walking the site's index a page at a time at the ten seconds both sites'
 * robots.txt ask for: some minutes per run, which is why the route that
 * starts this answers at once and lets it finish in the background.
 */

export type CriticListSource = "reverseshot" | "bordwell";

export interface CriticListRunResult {
  /** Index and article pages fetched this run. */
  pagesRead: number;
  /** Lists on the site that are not stored yet. */
  candidates: number;
  listsFound: number;
  entriesFound: number;
  matchedCount: number;
}

type Progress = (state: { pagesRead: number; listsFound: number; matchedCount: number }) => void;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const REVERSE_SHOT = "https://reverseshot.org";
const BORDWELL = "https://www.davidbordwell.net";
/** Safety caps on the index walks; both sites end well short of these. */
const MAX_FEATURE_PAGES = 150;
const MAX_SEARCH_PAGES = 15;

interface Site {
  sourceId: string;
  discover: (counted: () => void) => Promise<string[]>;
  fetch: (url: string) => Promise<string | null>;
  parse: (html: string) => ParsedCriticList | null;
  delayMs: number;
}

/** Reverse Shot's features index, /features then /features/2 …, kept to the best-of lists. */
async function discoverReverseShotLists(counted: () => void): Promise<string[]> {
  const seen = new Set<string>();
  const lists = new Set<string>();
  for (let page = 1; page <= MAX_FEATURE_PAGES; page++) {
    const html = await fetchReverseShotHtml(page === 1 ? "/features" : `/features/${page}`);
    counted();
    await sleep(REVERSE_SHOT_REQUEST_DELAY_MS);
    if (!html) break;
    const before = seen.size;
    for (const m of html.matchAll(/\/features\/(\d+)\/([A-Za-z0-9_-]+)/g)) {
      const path = `/features/${m[1]}/${m[2]}`;
      seen.add(path);
      if (isReverseShotListSlug(m[2]!)) lists.add(`${REVERSE_SHOT}${path}`);
    }
    // A page past the end repeats what is already known, or has nothing.
    if (seen.size === before) break;
  }
  return [...lists];
}

/** The ten-best posts, through the blog's own search: they share a title and nothing else marks them. */
async function discoverBordwellLists(counted: () => void): Promise<string[]> {
  const lists = new Set<string>();
  let quietPages = 0;
  for (let page = 1; page <= MAX_SEARCH_PAGES && quietPages < 2; page++) {
    const html = await fetchBordwellHtml(
      page === 1 ? "/blog/?s=ten+best+films+of" : `/blog/page/${page}/?s=ten+best+films+of`,
    );
    counted();
    await sleep(BORDWELL_REQUEST_DELAY_MS);
    if (!html) break;
    const before = lists.size;
    for (const m of html.matchAll(/href="(https?:\/\/www\.davidbordwell\.net\/blog\/\d{4}\/\d{2}\/\d{2}\/[^"/]+\/?)"/g)) {
      // The site links to itself over http as often as https.
      const url = m[1]!.replace(/^http:\/\//, "https://").replace(/\/?$/, "/");
      if (isBordwellTenBestUrl(url)) lists.add(url);
    }
    quietPages = lists.size === before ? quietPages + 1 : 0;
  }
  return [...lists];
}

const SITES: Record<CriticListSource, Site> = {
  reverseshot: {
    sourceId: "reverseshot",
    discover: discoverReverseShotLists,
    fetch: (url) => fetchReverseShotHtml(url.replace(REVERSE_SHOT, "")),
    parse: parseReverseShotBestOf,
    delayMs: REVERSE_SHOT_REQUEST_DELAY_MS,
  },
  bordwell: {
    sourceId: "davidbordwell",
    discover: discoverBordwellLists,
    fetch: (url) => fetchBordwellHtml(url.replace(BORDWELL, "")),
    parse: parseBordwellTenBest,
    delayMs: BORDWELL_REQUEST_DELAY_MS,
  },
};

/**
 * Lists of this source already stored AS lists. Not withoutStoredUrls(): the
 * review scraper has usually stored a ten-best post already, as an ordinary
 * post naming one film, and that copy is exactly what this run replaces.
 */
function storedListUrls(sourceId: string): Set<string> {
  return new Set(
    asRows<{ url: string }>(
      getDb()
        .prepare("SELECT url FROM scraped_articles WHERE source_id = ? AND article_type = 'accolade'")
        .all(sourceId),
    ).map((r) => r.url),
  );
}

export async function runCriticListScrape(source: CriticListSource, onProgress?: Progress): Promise<CriticListRunResult> {
  const site = SITES[source];
  let pagesRead = 0;
  let listsFound = 0;
  let entriesFound = 0;
  let matchedCount = 0;
  const report = () => onProgress?.({ pagesRead, listsFound, matchedCount });

  const stored = storedListUrls(site.sourceId);
  const candidates = (await site.discover(() => {
    pagesRead++;
    report();
  })).filter((url) => !stored.has(url));

  for (const url of candidates) {
    const html = await site.fetch(url);
    pagesRead++;
    await sleep(site.delayMs);
    // A failed fetch is simply tried again by the next run.
    if (!html) continue;

    const list = site.parse(html);
    if (!list) {
      report();
      continue;
    }

    const mentions: FilmMentionInput[] = list.entries.map((entry) => ({
      rawTitle: entry.title,
      rawYear: list.year,
      accoladeRank: entry.rank,
      accoladeLabel: entry.rank === null ? `${LISTED_PREFIX}${list.headline}` : null,
      windowText: entry.paragraphs.join("\n\n"),
      skipCandidateExtraction: entry.paragraphs.length === 0,
      // One critic's case for the film; the film page shows trivia as fact.
      skipTrivia: true,
    }));

    const result = await upsertScrapedArticle(
      {
        sourceId: site.sourceId,
        url,
        title: list.headline,
        articleType: "accolade",
        fullText: list.entries
          .map((e) => [`${e.rank === null ? "" : `${e.rank}. `}${e.title}`, ...e.paragraphs].join("\n\n"))
          .join("\n\n"),
      },
      mentions,
    );

    listsFound++;
    entriesFound += list.entries.length;
    matchedCount += result.matchedCount;
    report();
  }

  return { pagesRead, candidates: candidates.length, listsFound, entriesFound, matchedCount };
}
