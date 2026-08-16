import { requireAdmin } from "@/lib/admin-auth";
import { asRows, getDb } from "@/lib/db";
import { getArticle, type ArticleFilmLink } from "@/lib/scraping/articles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * GET /api/admin/accolades/article/{articleId}
 *
 * The ONE place full_text is allowed to leave the database — admin-key-
 * gated, for the dashboard's "Read full text" reader and the "Review
 * matches" view (every film mention this article/book produced, exact
 * matches included, so the curator can confirm a fuzzy guess or link an
 * unmatched title by hand). The public film page never calls this; it only
 * ever goes through resolve.ts's short-string read path.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ articleId: string }> },
): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const { articleId } = await params;
  const article = getArticle(articleId);
  if (!article) {
    return Response.json({ error: "not_found", message: "No such article." }, { status: 404, headers: NO_STORE });
  }
  const links = asRows<ArticleFilmLink>(
    getDb().prepare("SELECT * FROM article_film_links WHERE article_id = ? ORDER BY raw_title").all(articleId),
  );
  return Response.json({ article, links }, { headers: NO_STORE });
}
