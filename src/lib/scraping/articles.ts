import "server-only";

import { generateId } from "../crypto";
import { asRow, asRows, getDb, transaction } from "../db";
import { matchTitle } from "./match";
import { normaliseTitle } from "../library-review";

/**
 * Storage for one fetched article or one uploaded book's extracted text —
 * shared by all three ingestion paths (yearendlists, Wikipedia, PDF
 * uploads) so "save the full text, resolve every film it mentions, extract
 * blurb/trivia candidates for each" means the same thing regardless of
 * source.
 */

export type ArticleType = "review" | "accolade";

export interface ScrapedArticleInput {
  sourceId: string;
  url: string;
  title: string;
  articleType: ArticleType;
  publishedAt?: number | null;
  fullText: string;
}

export interface FilmMentionInput {
  rawTitle: string;
  rawYear?: number | null;
  /** A ranked-list entry ("#7"). Null for a review's single subject film, or for a win/nomination — those use accoladeLabel instead. */
  accoladeRank?: number | null;
  /** Non-numeric accolade text, e.g. "Won: Best Sound Editing, 92nd Academy Awards". Null for a plain review link or a ranked entry (which uses accoladeRank). */
  accoladeLabel?: string | null;
  /**
   * Skips blurb/trivia extraction for this mention. Set on every entry
   * after the first when one article produces several article_film_links
   * rows for the SAME film (Wikipedia: one row per award result, all
   * windowing to the same text) — without this, the same candidates would
   * be duplicated once per accolade row instead of stored once.
   */
  skipCandidateExtraction?: boolean;
}

export interface ScrapedArticle {
  id: string;
  source_id: string;
  url: string;
  title: string;
  article_type: ArticleType;
  published_at: number | null;
  full_text: string;
  fetched_at: number;
}

export interface ArticleFilmLink {
  id: string;
  article_id: string;
  imdb_id: string | null;
  raw_title: string;
  raw_year: number | null;
  confidence: "exact" | "fuzzy" | "unmatched";
  accolade_rank: number | null;
  accolade_label: string | null;
  created_at: number;
}

/**
 * Blank-line-separated blocks, collapsed to single lines and trimmed. Short
 * fragments (bylines, section headers, "Advertisement") are dropped rather
 * than offered as blurb candidates — 40 characters is short enough to keep
 * a punchy one-liner, long enough to filter out non-prose noise.
 *
 * Takes a WINDOW of text (see windowTextAroundMention), not necessarily the
 * whole article — a single-subject review's window is the whole text, but a
 * multi-film source's window is just the paragraph(s) near one mention.
 */
export function splitIntoBlurbCandidates(windowText: string): string[] {
  return windowText
    .split(/\n{2,}/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p.length >= 40);
}

/**
 * Sentence-level split of the same window, for short factual asides rather
 * than quotable pull-quotes. Filters out very short/very long sentences (a
 * fragment or a run-on paragraph the naive splitter didn't break cleanly)
 * and anything wrapped in quotation marks — quoted dialogue or a pulled
 * review line reads as evaluative, not factual, and belongs in the blurb
 * pool instead. This is a heuristic, not a classifier: false positives and
 * negatives are expected and the curator has the final say either way.
 */
export function splitIntoTriviaCandidates(windowText: string): string[] {
  return windowText
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+(?=[A-Z"“])/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 30 && s.length <= 280)
    .filter((s) => !/^["“]/.test(s));
}

/**
 * The paragraph(s) actually about one film, out of a source that may cover
 * many. Finds the first paragraph whose normalised text contains the
 * mention's normalised title and takes it plus one paragraph on either
 * side; falls back to the whole text when no paragraph matches (the normal
 * case for a single-subject review or a Wikipedia film page, where the
 * "mention" is the entire article).
 */
export function windowTextAroundMention(fullText: string, rawTitle: string): string {
  const key = normaliseTitle(rawTitle);
  if (!key) return fullText;

  const paragraphs = fullText.split(/\n{2,}/);
  const index = paragraphs.findIndex((p) => normaliseTitle(p).includes(key));
  if (index === -1) return fullText;

  return paragraphs.slice(Math.max(0, index - 1), index + 2).join("\n\n");
}

/**
 * Inserts or (on a re-scrape of the same URL) replaces an article, its film
 * mentions, and each mention's windowed blurb/trivia candidates. Matching
 * runs first and fully async, against a plain snapshot of the resolved
 * mentions — the actual DB writes then happen in one synchronous
 * transaction, because db.ts's transaction() forbids awaiting inside it (an
 * await would hold the write lock open across the Jellyfin fetch matchTitle
 * makes on a cold index).
 */
export async function upsertScrapedArticle(
  article: ScrapedArticleInput,
  mentions: FilmMentionInput[],
): Promise<{ articleId: string; matchedCount: number }> {
  const existing = asRow<{ id: string }>(
    getDb().prepare("SELECT id FROM scraped_articles WHERE url = ?").get(article.url),
  );
  const articleId = existing?.id ?? generateId();
  const now = Date.now();

  const resolved = await Promise.all(
    mentions.map(async (m) => ({
      ...m,
      linkId: generateId(),
      match: await matchTitle(m.rawTitle, m.rawYear ?? null),
      window: windowTextAroundMention(article.fullText, m.rawTitle),
    })),
  );

  transaction((db) => {
    if (existing) {
      db.prepare(
        `UPDATE scraped_articles
            SET title = ?, article_type = ?, published_at = ?, full_text = ?, fetched_at = ?
          WHERE id = ?`,
      ).run(article.title, article.articleType, article.publishedAt ?? null, article.fullText, now, articleId);
      // article_blurb_candidates / article_trivia_candidates cascade off
      // article_film_links, so deleting the old links is enough to clear them.
      db.prepare("DELETE FROM article_film_links WHERE article_id = ?").run(articleId);
    } else {
      db.prepare(
        `INSERT INTO scraped_articles (id, source_id, url, title, article_type, published_at, full_text, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        articleId,
        article.sourceId,
        article.url,
        article.title,
        article.articleType,
        article.publishedAt ?? null,
        article.fullText,
        now,
      );
    }

    for (const mention of resolved) {
      db.prepare(
        `INSERT INTO article_film_links
           (id, article_id, imdb_id, raw_title, raw_year, confidence, accolade_rank, accolade_label, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        mention.linkId,
        articleId,
        mention.match.imdbId,
        mention.rawTitle,
        mention.rawYear ?? null,
        mention.match.confidence,
        mention.accoladeRank ?? null,
        mention.accoladeLabel ?? null,
        now,
      );

      if (mention.skipCandidateExtraction) continue;

      splitIntoBlurbCandidates(mention.window).forEach((text, position) => {
        db.prepare(
          "INSERT INTO article_blurb_candidates (id, link_id, passage_text, position) VALUES (?, ?, ?, ?)",
        ).run(generateId(), mention.linkId, text, position);
      });

      splitIntoTriviaCandidates(mention.window).forEach((text, position) => {
        db.prepare(
          "INSERT INTO article_trivia_candidates (id, link_id, fact_text, position) VALUES (?, ?, ?, ?)",
        ).run(generateId(), mention.linkId, text, position);
      });
    }
  });

  return {
    articleId,
    matchedCount: resolved.filter((m) => m.match.confidence !== "unmatched").length,
  };
}

export function getArticle(articleId: string): ScrapedArticle | undefined {
  return asRow<ScrapedArticle>(
    getDb().prepare("SELECT * FROM scraped_articles WHERE id = ?").get(articleId),
  );
}

export function listArticlesForFilm(imdbId: string): Array<ScrapedArticle & { link: ArticleFilmLink }> {
  interface Row extends ScrapedArticle {
    link_id: string;
    link_raw_title: string;
    link_raw_year: number | null;
    link_confidence: ArticleFilmLink["confidence"];
    link_rank: number | null;
    link_label: string | null;
    link_created_at: number;
  }
  return asRows<Row>(
    getDb()
      .prepare(
        `SELECT a.*, l.id AS link_id, l.raw_title AS link_raw_title, l.raw_year AS link_raw_year,
                l.confidence AS link_confidence, l.accolade_rank AS link_rank,
                l.accolade_label AS link_label, l.created_at AS link_created_at
           FROM article_film_links l
           JOIN scraped_articles a ON a.id = l.article_id
          WHERE l.imdb_id = ?
          ORDER BY a.fetched_at DESC`,
      )
      .all(imdbId),
  ).map((row) => {
    const {
      link_id,
      link_raw_title,
      link_raw_year,
      link_confidence,
      link_rank,
      link_label,
      link_created_at,
      ...articleFields
    } = row;
    return {
      ...articleFields,
      link: {
        id: link_id,
        article_id: articleFields.id,
        imdb_id: imdbId,
        raw_title: link_raw_title,
        raw_year: link_raw_year,
        confidence: link_confidence,
        accolade_rank: link_rank,
        accolade_label: link_label,
        created_at: link_created_at,
      },
    };
  });
}

export interface BlurbCandidate {
  id: string;
  passage_text: string;
  link_id: string;
  article_id: string;
  article_title: string;
  article_url: string;
  source_id: string;
  source_name: string;
}

const BLURB_CANDIDATE_SELECT = `
  SELECT bc.id, bc.passage_text, bc.link_id, a.id AS article_id, a.title AS article_title,
         a.url AS article_url, a.source_id, src.name AS source_name
    FROM article_blurb_candidates bc
    JOIN article_film_links l ON l.id = bc.link_id
    JOIN scraped_articles a ON a.id = l.article_id
    JOIN scrape_sources src ON src.id = a.source_id`;

/** A film's candidates come only from ITS OWN mentions (link rows), never every candidate in a multi-film source. */
export function blurbCandidatesForFilm(imdbId: string): BlurbCandidate[] {
  return asRows<BlurbCandidate>(
    getDb()
      .prepare(`${BLURB_CANDIDATE_SELECT} WHERE l.imdb_id = ? ORDER BY a.fetched_at DESC, bc.position ASC`)
      .all(imdbId),
  );
}

export function getBlurbCandidate(id: string): BlurbCandidate | undefined {
  return asRow<BlurbCandidate>(getDb().prepare(`${BLURB_CANDIDATE_SELECT} WHERE bc.id = ?`).get(id));
}

export interface TriviaCandidate {
  id: string;
  fact_text: string;
  link_id: string;
  article_id: string;
  article_title: string;
  source_id: string;
}

export function triviaCandidatesForFilm(imdbId: string): TriviaCandidate[] {
  return asRows<TriviaCandidate>(
    getDb()
      .prepare(
        `SELECT tc.id, tc.fact_text, tc.link_id, a.id AS article_id, a.title AS article_title, a.source_id
           FROM article_trivia_candidates tc
           JOIN article_film_links l ON l.id = tc.link_id
           JOIN scraped_articles a ON a.id = l.article_id
          WHERE l.imdb_id = ?
          ORDER BY a.fetched_at DESC, tc.position ASC`,
      )
      .all(imdbId),
  );
}

export interface AccoladeMention {
  id: string;
  imdb_id: string;
  accolade_rank: number | null;
  accolade_label: string | null;
  article_title: string;
  article_url: string;
  source_name: string;
}

/** Every scraped accolade mention (ranked or win/nomination) for one film — a plain review link has both fields null and is excluded. */
export function accoladeMentionsForFilm(imdbId: string): AccoladeMention[] {
  return asRows<AccoladeMention>(
    getDb()
      .prepare(
        `SELECT l.id, l.imdb_id, l.accolade_rank, l.accolade_label, a.title AS article_title, a.url AS article_url, src.name AS source_name
           FROM article_film_links l
           JOIN scraped_articles a ON a.id = l.article_id
           JOIN scrape_sources src ON src.id = a.source_id
          WHERE l.imdb_id = ? AND (l.accolade_rank IS NOT NULL OR l.accolade_label IS NOT NULL)
          ORDER BY (l.accolade_label IS NOT NULL) DESC, l.accolade_rank ASC`,
      )
      .all(imdbId),
  );
}

export function getAccoladeMention(linkId: string): AccoladeMention | undefined {
  return asRow<AccoladeMention>(
    getDb()
      .prepare(
        `SELECT l.id, l.imdb_id, l.accolade_rank, l.accolade_label, a.title AS article_title, a.url AS article_url, src.name AS source_name
           FROM article_film_links l
           JOIN scraped_articles a ON a.id = l.article_id
           JOIN scrape_sources src ON src.id = a.source_id
          WHERE l.id = ?`,
      )
      .get(linkId),
  );
}

interface UnmatchedRow {
  id: string;
  raw_title: string;
  raw_year: number | null;
}

/**
 * Re-attempts matching for every article_film_links row that couldn't be
 * placed at ingestion time — called from the library scan (the same hook
 * point the group/series auto-relink logic already uses), so a mention of a
 * not-yet-owned film links itself the moment that film is scanned in.
 * Sequential rather than Promise.all: matchTitle's library index is built
 * once and cached, so there is no concurrency to gain, and this keeps each
 * row's write ordered and simple to reason about during a scan.
 *
 * Also re-checks existing "exact" rows, not just null imdb_id ones: exact is
 * the one confidence level matchTitle() treats as reliable enough not to
 * need a curator's eyes, so if its own logic changes (e.g. tightening the
 * year-tolerance fallback), previously-stored exact matches need the same
 * re-validation as a brand-new title would get, not just future scrapes.
 * Rows that come back unchanged (same imdb_id and confidence) are skipped —
 * only real corrections get written.
 */
export async function relinkUnmatchedArticleLinks(): Promise<number> {
  const candidates = asRows<UnmatchedRow & { imdb_id: string | null; confidence: string }>(
    getDb()
      .prepare(
        "SELECT id, raw_title, raw_year, imdb_id, confidence FROM article_film_links WHERE imdb_id IS NULL OR confidence = 'exact'",
      )
      .all(),
  );
  let relinked = 0;
  for (const row of candidates) {
    const match = await matchTitle(row.raw_title, row.raw_year);
    if (match.imdbId === row.imdb_id && match.confidence === row.confidence) continue;
    getDb()
      .prepare("UPDATE article_film_links SET imdb_id = ?, confidence = ? WHERE id = ?")
      .run(match.imdbId, match.confidence, row.id);
    relinked++;
  }
  return relinked;
}

/** Same relink pass for the curator's own accolade-list entries. */
export async function relinkUnmatchedAccoladeEntries(): Promise<number> {
  const unmatched = asRows<UnmatchedRow>(
    getDb()
      .prepare("SELECT id, raw_title, raw_year FROM curator_accolade_entries WHERE imdb_id IS NULL")
      .all(),
  );
  let relinked = 0;
  for (const row of unmatched) {
    const match = await matchTitle(row.raw_title, row.raw_year);
    if (match.confidence === "unmatched") continue;
    getDb().prepare("UPDATE curator_accolade_entries SET imdb_id = ? WHERE id = ?").run(match.imdbId, row.id);
    relinked++;
  }
  return relinked;
}
