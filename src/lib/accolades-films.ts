import "server-only";

import { getAdminMovies } from "./admin-library-cache";
import { adminThumbUrl } from "./admin-thumb";
import { asRows, getDb } from "./db";

/**
 * Every film in the library with the state of its editorial curation.
 *
 * The Accolades tab opened on a search box, which meant the only way to see a
 * film's material was to already know which film you wanted. Measured against
 * the real database when this was written: 3,324 articles scraped into 58,311
 * blurb candidates and 187,799 trivia candidates across 330 films — and zero
 * blurbs, zero trivia and zero accolades ever chosen. The material was not
 * missing, it was invisible.
 *
 * So this answers the question the tab could not: which films have something
 * worth reading attached, and which have already been dealt with.
 *
 * Counting is done with four grouped queries over indexed columns rather than
 * per film — at ~1,200 films a per-film query would be ~5,000 round trips to
 * SQLite for one page load.
 */

export interface AccoladeFilm {
  imdbId: string;
  name: string;
  year: number | null;
  posterUrl: string | null;
  /** Distinct articles linked to this film. */
  articles: number;
  blurbCandidates: number;
  triviaCandidates: number;
  /** Trivia lines the curator has actually chosen. */
  triviaChosen: number;
  blurbChosen: boolean;
  accoladeChosen: boolean;
  /** Anything at all to look at — the "material waiting" chip. */
  hasMaterial: boolean;
  /** Something has been chosen, so this film has been dealt with. */
  curated: boolean;
}

function countsByImdb(sql: string): Map<string, number> {
  const rows = asRows<{ imdb_id: string; n: number }>(getDb().prepare(sql).all());
  const map = new Map<string, number>();
  for (const r of rows) if (r.imdb_id) map.set(r.imdb_id, r.n);
  return map;
}

export async function listAccoladeFilms(): Promise<AccoladeFilm[]> {
  // The light shape: names, years, provider ids and image tags, no
  // MediaSources. Nothing here needs a stream list.
  const movies = await getAdminMovies({ withMediaSources: false });

  const articles = countsByImdb(`
    SELECT imdb_id, COUNT(DISTINCT article_id) AS n
      FROM article_film_links
     WHERE imdb_id IS NOT NULL
     GROUP BY imdb_id`);

  const blurbs = countsByImdb(`
    SELECT l.imdb_id AS imdb_id, COUNT(*) AS n
      FROM article_blurb_candidates c
      JOIN article_film_links l ON l.id = c.link_id
     WHERE l.imdb_id IS NOT NULL
     GROUP BY l.imdb_id`);

  const trivia = countsByImdb(`
    SELECT l.imdb_id AS imdb_id, COUNT(*) AS n
      FROM article_trivia_candidates c
      JOIN article_film_links l ON l.id = c.link_id
     WHERE l.imdb_id IS NOT NULL
     GROUP BY l.imdb_id`);

  const chosen = countsByImdb(`
    SELECT imdb_id, COUNT(*) AS n
      FROM film_trivia_selections
     GROUP BY imdb_id`);

  const lockRows = asRows<{
    imdb_id: string;
    locked_blurb_candidate_id: string | null;
    locked_blurb_text: string | null;
    locked_accolade_link_id: string | null;
    locked_accolade_entry_id: string | null;
  }>(getDb().prepare("SELECT * FROM film_curation_locks").all());

  const locks = new Map(lockRows.map((r) => [r.imdb_id, r]));

  const out: AccoladeFilm[] = [];
  for (const movie of movies) {
    const imdbId = movie.ProviderIds?.Imdb;
    // No IMDb id means nothing can be attached to it — every accolade table
    // is keyed on one, so such a film has no editorial state to show.
    if (!imdbId) continue;

    const lock = locks.get(imdbId);
    const blurbChosen = !!(lock?.locked_blurb_candidate_id || lock?.locked_blurb_text);
    const accoladeChosen = !!(lock?.locked_accolade_link_id || lock?.locked_accolade_entry_id);
    const triviaChosen = chosen.get(imdbId) ?? 0;
    const articleCount = articles.get(imdbId) ?? 0;
    const blurbCandidates = blurbs.get(imdbId) ?? 0;
    const triviaCandidates = trivia.get(imdbId) ?? 0;

    out.push({
      imdbId,
      name: movie.Name,
      year: movie.ProductionYear ?? null,
      posterUrl: adminThumbUrl(movie.Id, movie.ImageTags?.Primary),
      articles: articleCount,
      blurbCandidates,
      triviaCandidates,
      triviaChosen,
      blurbChosen,
      accoladeChosen,
      hasMaterial: articleCount > 0 || blurbCandidates > 0 || triviaCandidates > 0,
      curated: blurbChosen || accoladeChosen || triviaChosen > 0,
    });
  }

  return out;
}
