import { requireAdmin } from "@/lib/admin-auth";
import { asRow, asRows, getDb } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;
const PAGE_SIZE = 60;

interface BrowseArticleRow {
  id: string;
  title: string;
  url: string;
  source_id: string;
  source_name: string;
  fetched_at: number;
  matched_count: number;
  unmatched_count: number;
}

interface SourceBreakdownRow {
  source_id: string;
  source_name: string;
  article_count: number;
  matched_count: number;
}

/**
 * GET /api/admin/accolades/browse?q=&source=&matched=only|none&offset=
 *
 * The cross-source view: every scraped_articles row from every source in
 * one searchable, filterable list, plus the per-source breakdown that
 * drives the dashboard's summary bars. Reading a specific article's full
 * text still goes through the existing /article/{id} route (and the
 * existing reader panel) — this endpoint only ever returns titles, counts
 * and metadata, matching the "full_text leaves the database in exactly one
 * place" rule documented there.
 */
export async function GET(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  const source = (url.searchParams.get("source") ?? "").trim();
  const matched = url.searchParams.get("matched"); // "only" | "none" | null
  const offset = Math.max(0, Number.parseInt(url.searchParams.get("offset") ?? "0", 10) || 0);

  const db = getDb();

  const where: string[] = [];
  const params: (string | number)[] = [];
  if (q) {
    where.push("a.title LIKE ?");
    params.push(`%${q}%`);
  }
  if (source) {
    where.push("a.source_id = ?");
    params.push(source);
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

  const havingSql =
    matched === "only" ? "HAVING matched_count > 0" : matched === "none" ? "HAVING matched_count = 0" : "";

  const articles = asRows<BrowseArticleRow>(
    db
      .prepare(
        `SELECT a.id, a.title, a.url, a.source_id, src.name AS source_name, a.fetched_at,
                SUM(CASE WHEN l.imdb_id IS NOT NULL THEN 1 ELSE 0 END) AS matched_count,
                SUM(CASE WHEN l.imdb_id IS NULL THEN 1 ELSE 0 END) AS unmatched_count
           FROM scraped_articles a
           JOIN scrape_sources src ON src.id = a.source_id
           LEFT JOIN article_film_links l ON l.article_id = a.id
           ${whereSql}
          GROUP BY a.id
          ${havingSql}
          ORDER BY a.fetched_at DESC
          LIMIT ? OFFSET ?`,
      )
      .all(...params, PAGE_SIZE + 1, offset),
  );

  const hasMore = articles.length > PAGE_SIZE;
  const page = hasMore ? articles.slice(0, PAGE_SIZE) : articles;

  const bySource = asRows<SourceBreakdownRow>(
    db
      .prepare(
        `SELECT src.id AS source_id, src.name AS source_name,
                COUNT(DISTINCT a.id) AS article_count,
                COUNT(DISTINCT CASE WHEN l.imdb_id IS NOT NULL THEN a.id END) AS matched_count
           FROM scrape_sources src
           LEFT JOIN scraped_articles a ON a.source_id = src.id
           LEFT JOIN article_film_links l ON l.article_id = a.id
          GROUP BY src.id
          HAVING article_count > 0
          ORDER BY article_count DESC`,
      )
      .all(),
  );

  const totals = asRow<{ total_articles: number; total_matched: number }>(
    db
      .prepare(
        `SELECT COUNT(DISTINCT a.id) AS total_articles,
                COUNT(DISTINCT CASE WHEN l.imdb_id IS NOT NULL THEN l.id END) AS total_matched
           FROM scraped_articles a
           LEFT JOIN article_film_links l ON l.article_id = a.id`,
      )
      .get(),
  );

  return Response.json(
    {
      articles: page,
      hasMore,
      bySource,
      totals: totals ?? { total_articles: 0, total_matched: 0 },
    },
    { headers: NO_STORE },
  );
}
