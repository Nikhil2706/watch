import { requireAdmin } from "@/lib/admin-auth";
import { asRows, getDb } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

interface ArticleSummary {
  id: string;
  title: string;
  url: string;
  fetched_at: number;
  matched_count: number;
  unmatched_count: number;
}

/** GET /api/admin/accolades/sources/{id}/articles — every article/book fetched from one source, with a quick matched/unmatched tally. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const { id } = await params;
  const articles = asRows<ArticleSummary>(
    getDb()
      .prepare(
        `SELECT a.id, a.title, a.url, a.fetched_at,
                SUM(CASE WHEN l.imdb_id IS NOT NULL THEN 1 ELSE 0 END) AS matched_count,
                SUM(CASE WHEN l.imdb_id IS NULL THEN 1 ELSE 0 END) AS unmatched_count
           FROM scraped_articles a
           LEFT JOIN article_film_links l ON l.article_id = a.id
          WHERE a.source_id = ?
          GROUP BY a.id
          ORDER BY a.fetched_at DESC`,
      )
      .all(id),
  );
  return Response.json({ articles }, { headers: NO_STORE });
}
