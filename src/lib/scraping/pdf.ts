import "server-only";

// Must import before "pdf-parse" itself — sets up the worker pdf-parse's
// underlying pdfjs-dist engine needs in a plain Node server environment.
import "pdf-parse/worker";
import { PDFParse } from "pdf-parse";

import { listAllMoviesAdmin } from "../jellyfin";
import { normaliseTitle } from "../library-review";
import { upsertScrapedArticle, type FilmMentionInput } from "./articles";

/**
 * PDF book uploads — the curator's own file, so no network fetch and no ToS
 * question. Unlike Wikipedia/yearendlists (which already know which film
 * they're about), a book's full text has to be scanned to DISCOVER which
 * library films it mentions at all, then each mention gets windowed the
 * same way a multi-film web listicle would.
 */

export async function extractPdfText(buffer: Buffer): Promise<string> {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    // pdf-parse inserts a "-- N of M --" page-boundary marker between pages
    // (confirmed against a real extraction this session) — plain noise for
    // blurb/trivia purposes, stripped before anything downstream splits on it.
    return result.text.replace(/--\s*\d+\s+of\s+\d+\s*--/g, " ");
  } finally {
    await parser.destroy();
  }
}

/**
 * Scans a book's full text for every library film title that appears in
 * it — a simple substring search over normalised text, deliberately not
 * the fuzzy scorer in match.ts (that's for resolving one already-extracted
 * raw title, not for searching a few hundred pages for hundreds of
 * candidate titles, where fuzzy matching would produce far more false
 * positives than a plain title search does). Short titles (a handful of
 * normalised words or fewer) are skipped — a common word or two would
 * otherwise match constantly across an entire book.
 */
export async function findLibraryFilmsInText(fullText: string): Promise<FilmMentionInput[]> {
  const normalisedText = normaliseTitle(fullText);
  const movies = await listAllMoviesAdmin();

  const mentions: FilmMentionInput[] = [];
  for (const movie of movies) {
    const key = normaliseTitle(movie.Name);
    if (key.split(" ").filter(Boolean).length < 2) continue;
    if (!normalisedText.includes(key)) continue;

    mentions.push({
      rawTitle: movie.Name,
      rawYear: movie.ProductionYear ?? null,
    });
  }
  return mentions;
}

export interface PdfUploadResult {
  articleId: string;
  filmsFound: number;
  matchedCount: number;
}

/**
 * Stores an uploaded book: full text under the uploaded-books source, one
 * article_film_links row per library film found in it, each windowed to
 * the paragraph(s) actually mentioning that film for its blurb/trivia
 * candidates.
 */
export async function ingestPdfUpload(filename: string, buffer: Buffer): Promise<PdfUploadResult> {
  const fullText = await extractPdfText(buffer);
  const mentions = await findLibraryFilmsInText(fullText);

  const result = await upsertScrapedArticle(
    {
      sourceId: "uploaded-books",
      // Not a fetchable URL — a stable local reference, unique per upload
      // like every other scraped_articles.url, just not http(s).
      url: `upload://uploaded-books/${encodeURIComponent(filename)}-${Date.now()}`,
      title: filename.replace(/\.pdf$/i, ""),
      articleType: "review",
      fullText,
    },
    mentions,
  );

  return {
    articleId: result.articleId,
    filmsFound: mentions.length,
    matchedCount: result.matchedCount,
  };
}
