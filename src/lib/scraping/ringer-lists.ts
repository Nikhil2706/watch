import "server-only";

import { markUrlChecked, upsertScrapedArticle, withoutCheckedUrls, withoutStoredUrls, type FilmMentionInput } from "./articles";
import { discoverRingerMovieUrls, fetchRingerUrl, RINGER_REQUEST_DELAY_MS } from "./ringer";
import { listYearFromHeadline, parseRingerList } from "./ringer-list-parse";

/**
 * The Ringer's film lists and rankings — "The 10 Best Stephen King Movie
 * Adaptations", "The 25 Best Space Movies, Ranked", each year's best-of.
 *
 * ringer.ts takes the site's single-film reviews and deliberately leaves
 * these out, because a review links to one film and a list to many. They are
 * stored the way every other list is — one scraped_articles row, one
 * accolade mention per entry with its rank — with one addition the year-end
 * lists do not have: each entry's own paragraphs, kept as that mention's
 * passages. A pick converted from one of these arrives with its writeups.
 *
 * Nothing in a URL says an article is a list (the Stephen King one is
 * ".../stephen-king-movies-adaptations-it-carrie-shining-..."), so every
 * article under /movies/ that is not a review is opened once and read. Only
 * a few in a hundred are lists; the rest are remembered as checked and never
 * fetched again.
 */

export interface RingerListRunResult {
  /** Articles opened this run. */
  checked: number;
  listsFound: number;
  entriesFound: number;
  matchedCount: number;
  /** Candidates still unopened — a later run carries on from here. */
  remaining: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function publishedAtFromUrl(url: string): number | null {
  const m = url.match(/theringer\.com\/(\d{4})\/(\d{2})\/(\d{2})\//);
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

export async function runRingerListScrape(
  limit: number,
  onProgress?: (state: { checked: number; listsFound: number; matchedCount: number }) => void,
): Promise<RingerListRunResult> {
  const candidates = withoutCheckedUrls(
    "the-ringer",
    withoutStoredUrls("the-ringer", await discoverRingerMovieUrls()),
  );
  const batch = candidates.slice(0, limit);

  let checked = 0;
  let listsFound = 0;
  let entriesFound = 0;
  let matchedCount = 0;

  for (const url of batch) {
    const html = await fetchRingerUrl(url);
    await sleep(RINGER_REQUEST_DELAY_MS);
    // A failed fetch is not marked: the next run tries it again.
    if (!html) continue;
    checked++;

    const list = parseRingerList(html);
    if (!list) {
      markUrlChecked("the-ringer", url);
      onProgress?.({ checked, listsFound, matchedCount });
      continue;
    }

    const listYear = listYearFromHeadline(list.headline);
    const mentions: FilmMentionInput[] = list.entries.map((entry) => ({
      rawTitle: entry.title,
      rawYear: entry.year ?? listYear,
      accoladeRank: entry.rank,
      // An entry with no text of its own gets no passages, rather than the
      // paragraphs of whichever neighbour mentions it.
      windowText: entry.paragraphs.join("\n\n"),
      skipCandidateExtraction: entry.paragraphs.length === 0,
      skipTrivia: true,
    }));

    const result = await upsertScrapedArticle(
      {
        sourceId: "the-ringer",
        url,
        title: list.author ? `${list.headline} (${list.author})` : list.headline,
        articleType: "accolade",
        publishedAt: publishedAtFromUrl(url),
        fullText: list.entries
          .map((e) =>
            [`${e.rank === null ? "" : `${e.rank}. `}${e.title}${e.year ? ` (${e.year})` : ""}`, ...e.paragraphs].join(
              "\n\n",
            ),
          )
          .join("\n\n"),
      },
      mentions,
    );

    listsFound++;
    entriesFound += list.entries.length;
    matchedCount += result.matchedCount;
    onProgress?.({ checked, listsFound, matchedCount });
  }

  return { checked, listsFound, entriesFound, matchedCount, remaining: candidates.length - batch.length };
}
