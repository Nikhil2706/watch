import "server-only";

import { getAdminMovies } from "./admin-library-cache";
import { adminThumbUrl } from "./admin-thumb";
import { asRows, getDb } from "./db";
import { getGroup, getGroupSeriesPoster } from "./library-curation";
import type { PickItem } from "./picks";

/**
 * What the console's Picks tab needs that the viewer pages do not: every
 * title of a pick including the ones the library lacks, the lists a pick can
 * be started from, and the scraped passages on offer for a writeup.
 *
 * Admin-key gated at the routes; there is no viewer session here, so posters
 * go through the admin thumbnail route rather than /jf.
 */

export interface AdminPickItem extends PickItem {
  /** False for an entry of a converted list that the library does not have yet. */
  inLibrary: boolean;
  /** The library's own title and year where matched, the source's otherwise. */
  displayTitle: string;
  displayYear: number | null;
  posterUrl: string | null;
}

export async function describePickItems(items: PickItem[]): Promise<AdminPickItem[]> {
  const movies = await getAdminMovies({ withMediaSources: false });
  const byImdb = new Map(movies.filter((m) => m.ProviderIds?.Imdb).map((m) => [m.ProviderIds!.Imdb!, m]));
  const byPath = new Map(movies.filter((m) => m.Path).map((m) => [m.Path!, m]));

  return items.map((item) => {
    if (item.kind === "show") {
      const group = item.group_id ? getGroup(item.group_id) : null;
      const file = group?.paths[0] ? byPath.get(group.paths[0]) : undefined;
      return {
        ...item,
        inLibrary: !!group,
        displayTitle: group?.groupName ?? item.raw_title,
        displayYear: null,
        posterUrl: group
          ? getGroupSeriesPoster(group.groupId) ?? (file ? adminThumbUrl(file.Id, file.ImageTags?.Primary) : null)
          : null,
      };
    }
    const movie = item.imdb_id ? byImdb.get(item.imdb_id) : undefined;
    return {
      ...item,
      inLibrary: !!movie,
      displayTitle: movie?.Name ?? item.raw_title,
      displayYear: movie?.ProductionYear ?? item.raw_year,
      posterUrl: movie ? adminThumbUrl(movie.Id, movie.ImageTags?.Primary) : null,
    };
  });
}

export interface PickSource {
  kind: "article" | "accolade";
  id: string;
  title: string;
  /** "Year End Lists", "The Ringer", or "Your accolade". */
  sourceName: string;
  entries: number;
  inLibrary: number;
  ranked: boolean;
  /** Entries that come with their own text, which becomes each title's writeup. */
  withWriteups: number;
}

/**
 * Lists a pick can be started from: the curator's own accolades, and every
 * scraped article that names enough films to be a list. Searched by title,
 * best-stocked first — most year-end lists have only a handful of their
 * films in the library, and those are the ones worth converting.
 */
export function listPickSources(query: string, limit = 40): PickSource[] {
  const like = `%${query.trim().replace(/[%_]/g, "")}%`;

  const accolades = asRows<{ id: string; title: string; entries: number; in_library: number; with_writeups: number }>(
    getDb()
      .prepare(
        `SELECT a.id, a.name AS title, COUNT(e.id) AS entries,
                COALESCE(SUM(e.imdb_id IS NOT NULL), 0) AS in_library,
                COALESCE(SUM(e.blurb_text IS NOT NULL), 0) AS with_writeups
           FROM curator_accolades a
           LEFT JOIN curator_accolade_entries e ON e.accolade_id = a.id
          WHERE a.name LIKE ?
          GROUP BY a.id
          ORDER BY a.updated_at DESC`,
      )
      .all(like),
  ).map(
    (r): PickSource => ({
      kind: "accolade",
      id: r.id,
      title: r.title,
      sourceName: "Your accolade",
      entries: r.entries,
      inLibrary: r.in_library,
      ranked: true,
      withWriteups: r.with_writeups,
    }),
  );

  const articles = asRows<{
    id: string;
    title: string;
    source_name: string;
    entries: number;
    in_library: number;
    ranked: number;
    with_writeups: number;
  }>(
    getDb()
      .prepare(
        `SELECT a.id, a.title, s.name AS source_name,
                COUNT(DISTINCT COALESCE(l.imdb_id, l.raw_title)) AS entries,
                COUNT(DISTINCT l.imdb_id) AS in_library,
                MAX(l.accolade_rank IS NOT NULL) AS ranked,
                SUM(a.article_type = 'accolade' AND EXISTS (
                      SELECT 1 FROM article_blurb_candidates c WHERE c.link_id = l.id)) AS with_writeups
           FROM scraped_articles a
           JOIN scrape_sources s ON s.id = a.source_id
           JOIN article_film_links l ON l.article_id = a.id
          WHERE a.title LIKE ?
          GROUP BY a.id
         HAVING entries >= 3 AND in_library >= 1
          ORDER BY in_library DESC, a.fetched_at DESC
          LIMIT ?`,
      )
      .all(like, limit),
  ).map(
    (r): PickSource => ({
      kind: "article",
      id: r.id,
      title: r.title,
      sourceName: r.source_name,
      entries: r.entries,
      inLibrary: r.in_library,
      ranked: r.ranked === 1,
      withWriteups: r.with_writeups,
    }),
  );

  return [...accolades, ...articles];
}

export interface WriteupPassage {
  id: string;
  text: string;
  sourceName: string;
  articleTitle: string;
  articleUrl: string | null;
}

/**
 * Passages already scraped for one film, offered beside its writeup box. The
 * curator picks one (or several, or types their own); nothing is chosen
 * automatically.
 */
export function writeupPassagesForFilm(imdbId: string, limit = 60): WriteupPassage[] {
  return asRows<{ id: string; passage_text: string; source_name: string; article_title: string; article_url: string }>(
    getDb()
      .prepare(
        `SELECT bc.id, bc.passage_text, src.name AS source_name, a.title AS article_title, a.url AS article_url
           FROM article_blurb_candidates bc
           JOIN article_film_links l ON l.id = bc.link_id
           JOIN scraped_articles a ON a.id = l.article_id
           JOIN scrape_sources src ON src.id = a.source_id
          WHERE l.imdb_id = ?
          ORDER BY (a.article_type = 'accolade') DESC, a.fetched_at DESC, bc.position ASC
          LIMIT ?`,
      )
      .all(imdbId, limit),
  ).map((r) => ({
    id: r.id,
    text: r.passage_text,
    sourceName: r.source_name,
    articleTitle: r.article_title,
    articleUrl: r.article_url.startsWith("http") ? r.article_url : null,
  }));
}
