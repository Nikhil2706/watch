import "server-only";

import { asRows, getDb } from "../db";
import { episodeKey } from "../episode-key";
import { markUrlChecked, upsertScrapedArticle, withoutCheckedUrls, withoutStoredUrls, type FilmMentionInput } from "./articles";
import { discoverRingerTvUrls, fetchRingerUrl, parseRingerReview, RINGER_REQUEST_DELAY_MS } from "./ringer";
import { parseRingerList } from "./ringer-list-parse";
import {
  episodeFromSlug,
  guessShowTitle,
  matchListEntry,
  matchShow,
  publishedAtFromTvUrl,
  tvSlug,
  type TvShow,
} from "./ringer-tv-match";

/**
 * The Ringer's TV writing: everything filed under /tv/ — reviews, weekly
 * recaps, finale pieces, rankings.
 *
 * ringer.ts and ringer-lists.ts read /movies/ only. This is the same site
 * and the same markup, so it reuses their page readers, but what an article
 * is ABOUT is a different question here. A film is matched by title against
 * the library's films (matchTitle). A show is a library group with a series
 * IMDb id, and an episode is one file in it, and neither can go through a
 * film matcher that would hand "Lost" or "Fargo" to a film. So this works
 * out the subject itself (ringer-tv-match.ts) and tells the store what it
 * found:
 *
 *   - an article about one episode of a library show ("…-season-2-episode-5-…")
 *     is linked to that episode, by the key an episode goes by everywhere
 *     else (episode-key.ts);
 *   - an article about a library show is linked to the show's series id;
 *   - anything else is stored unlinked, with the address's own guess at the
 *     show as its title, and is looked at again on every later run, so
 *     adding a show to the library brings its articles with it.
 *
 * Every article is kept, not only the matched ones: 2,887 of them when this
 * was written, read once each. Stored under a source of its own
 * ('the-ringer-tv'), which is what keeps the film relink pass in
 * articles.ts away from them.
 *
 * Nothing on the site shows any of this yet, deliberately: where a show's
 * and an episode's passages should appear has not been decided. That takes
 * an exclusion, not just an absence — an episode's page looks up passages by
 * its show's IMDb id, which is the id these are stored against — so the two
 * queries behind the public page leave this source out (HIDDEN_FROM_PAGES in
 * articles.ts). This is the collecting half.
 */

const SOURCE_ID = "the-ringer-tv";

interface LibraryShow extends TvShow {
  /** The show's series IMDb id. */
  imdbId: string;
}

/** Shows the library has that are linked to a series: the only ones with an id to hang an article on. */
function libraryShows(): LibraryShow[] {
  return asRows<{ group_id: string; group_name: string; imdb_id: string }>(
    getDb()
      .prepare(
        `SELECT DISTINCT g.group_id, g.group_name, s.imdb_id
           FROM library_groups g
           JOIN library_group_series s ON s.group_id = g.group_id
          WHERE s.imdb_id IS NOT NULL AND (s.kind IS NULL OR s.kind = 'series')`,
      )
      .all(),
  ).map((r) => ({ id: r.group_id, name: r.group_name, imdbId: r.imdb_id }));
}

/** "{groupId}:{season}:{episode}" -> the file, from the positions recorded when episode artwork was applied. */
function episodePaths(): Map<string, string> {
  const rows = asRows<{ path: string; group_id: string; season: number; episode: number }>(
    getDb()
      .prepare(
        `SELECT l.subject_id AS path, g.group_id, l.season, l.episode
           FROM tmdb_links l
           JOIN library_groups g ON g.path = l.subject_id
          WHERE l.subject_type = 'still' AND l.season IS NOT NULL AND l.episode IS NOT NULL`,
      )
      .all(),
  );
  return new Map(rows.map((r) => [`${r.group_id}:${r.season}:${r.episode}`, r.path]));
}

interface Subject {
  /** What the mention is stored against: an episode key, a series id, or null. */
  id: string | null;
  kind: "episode" | "show" | "none";
}

function subjectOf(slug: string, headline: string, shows: LibraryShow[], episodes: Map<string, string>): Subject {
  const show = matchShow(slug, headline, shows);
  if (!show) return { id: null, kind: "none" };
  const position = episodeFromSlug(slug);
  const path = position ? episodes.get(`${show.id}:${position.season}:${position.episode}`) : undefined;
  return path ? { id: episodeKey(path), kind: "episode" } : { id: show.imdbId, kind: "show" };
}

/**
 * Works out again what every stored article and list entry is about, against
 * the shows the library has now and the matching rule as it stands now.
 * Cheap — no fetching, the address and headline are already here — and it is
 * what makes "store everything" worth doing.
 *
 * Every mention, not only the unlinked ones: a show removed from the library
 * should let go of its articles, and when the rule is tightened (the first
 * version took any show quoted in a headline, and linked a Winning Time
 * review to Friday Night Lights) the links it made wrongly have to go too.
 * Returns how many mentions changed.
 */
export function relinkRingerTv(): number {
  const shows = libraryShows();
  const episodes = episodePaths();
  const mentions = asRows<{
    link_id: string;
    url: string;
    title: string;
    raw_title: string;
    article_type: string;
    imdb_id: string | null;
  }>(
    getDb()
      .prepare(
        `SELECT l.id AS link_id, a.url, a.title, l.raw_title, a.article_type, l.imdb_id
           FROM article_film_links l
           JOIN scraped_articles a ON a.id = l.article_id
          WHERE a.source_id = ?`,
      )
      .all(SOURCE_ID),
  );
  const update = getDb().prepare("UPDATE article_film_links SET imdb_id = ?, confidence = ? WHERE id = ?");
  let changed = 0;
  for (const row of mentions) {
    const slug = tvSlug(row.url);
    if (!slug) continue;
    // An article's one mention is the article's subject; a list's entry is a
    // title of its own.
    const id =
      row.article_type === "review"
        ? subjectOf(slug, row.title, shows, episodes).id
        : (matchListEntry(row.raw_title, shows)?.imdbId ?? null);
    if (id === row.imdb_id) continue;
    update.run(id, id ? "exact" : "unmatched", row.link_id);
    changed++;
  }
  return changed;
}

export interface RingerTvRunResult {
  /** Articles opened this run. */
  read: number;
  lists: number;
  /** Non-list articles linked to a library show or one of its episodes. */
  matchedArticles: number;
  /** Of those, the ones linked to a single episode. */
  matchedEpisodes: number;
  /** List entries naming a library show. */
  matchedEntries: number;
  /** Earlier unlinked articles linked this run because the library has grown. */
  relinked: number;
  /** Articles still unopened — a later run carries on from here. */
  remaining: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runRingerTvScrape(
  limit: number,
  onProgress?: (state: { read: number; lists: number; matched: number }) => void,
): Promise<RingerTvRunResult> {
  const relinked = relinkRingerTv();
  const shows = libraryShows();
  const episodes = episodePaths();

  const candidates = withoutCheckedUrls(SOURCE_ID, withoutStoredUrls(SOURCE_ID, await discoverRingerTvUrls()));
  const batch = candidates.slice(0, limit);

  let read = 0;
  let lists = 0;
  let matchedArticles = 0;
  let matchedEpisodes = 0;
  let matchedEntries = 0;
  const report = () => onProgress?.({ read, lists, matched: matchedArticles + matchedEntries });

  for (const url of batch) {
    const slug = tvSlug(url);
    const html = await fetchRingerUrl(url);
    await sleep(RINGER_REQUEST_DELAY_MS);
    // A failed fetch is not marked: the next run tries it again.
    if (!html || !slug) continue;
    read++;

    const publishedAt = publishedAtFromTvUrl(url);
    const list = parseRingerList(html);

    if (list) {
      const mentions: FilmMentionInput[] = list.entries.map((entry) => {
        const show = matchListEntry(entry.title, shows);
        if (show) matchedEntries++;
        return {
          rawTitle: entry.title,
          rawYear: entry.year,
          accoladeRank: entry.rank,
          resolvedImdbId: show?.imdbId ?? null,
          windowText: entry.paragraphs.join("\n\n"),
          skipCandidateExtraction: entry.paragraphs.length === 0,
          skipTrivia: true,
        };
      });
      await upsertScrapedArticle(
        {
          sourceId: SOURCE_ID,
          url,
          title: list.author ? `${list.headline} (${list.author})` : list.headline,
          articleType: "accolade",
          publishedAt,
          fullText: list.entries
            .map((e) => [`${e.rank === null ? "" : `${e.rank}. `}${e.title}`, ...e.paragraphs].join("\n\n"))
            .join("\n\n"),
        },
        mentions,
      );
      lists++;
      report();
      continue;
    }

    const article = parseRingerReview(html, url);
    if (!article) {
      // A page with no article text (a video, a podcast episode): not worth
      // opening twice.
      markUrlChecked(SOURCE_ID, url);
      report();
      continue;
    }

    const subject = subjectOf(slug, article.headline, shows, episodes);
    if (subject.kind !== "none") matchedArticles++;
    if (subject.kind === "episode") matchedEpisodes++;

    await upsertScrapedArticle(
      {
        sourceId: SOURCE_ID,
        url,
        title: article.headline,
        articleType: "review",
        publishedAt,
        fullText: article.bodyText,
      },
      [
        {
          rawTitle: guessShowTitle(slug) ?? article.headline,
          rawYear: null,
          resolvedImdbId: subject.id,
          // The whole article is about its one subject.
          windowText: article.bodyText,
          // A critic's reading of a show; the site shows trivia as fact.
          skipTrivia: true,
        },
      ],
    );
    report();
  }

  return { read, lists, matchedArticles, matchedEpisodes, matchedEntries, relinked, remaining: candidates.length - batch.length };
}
