import { requireAdmin } from "@/lib/admin-auth";
import { accoladeMentionsForFilm, blurbCandidatesForFilm, listArticlesForFilm, triviaCandidatesForFilm } from "@/lib/scraping/articles";
import { curatorAccoladeMentionsForFilm } from "@/lib/scraping/curator-accolades";
import { getLock } from "@/lib/scraping/locks";
import { listTriviaSelections } from "@/lib/scraping/trivia";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * GET /api/admin/accolades/film/{imdbId}
 *
 * Everything the Films tab's detail panel needs in one call: linked
 * articles (title/source only — full text is a separate, deliberately
 * distinct endpoint), blurb/trivia candidate pools, scraped and curator-
 * built accolade mentions, and the current lock state. Never includes
 * scraped_articles.full_text.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ imdbId: string }> },
): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const { imdbId } = await params;

  const articles = listArticlesForFilm(imdbId).map((a) => ({
    id: a.id,
    title: a.title,
    source_id: a.source_id,
    fetched_at: a.fetched_at,
    link: a.link,
  }));

  return Response.json(
    {
      imdbId,
      articles,
      blurbCandidates: blurbCandidatesForFilm(imdbId),
      accoladeMentions: accoladeMentionsForFilm(imdbId),
      curatorAccoladeMentions: curatorAccoladeMentionsForFilm(imdbId),
      triviaCandidates: triviaCandidatesForFilm(imdbId),
      triviaSelections: listTriviaSelections(imdbId),
      lock: getLock(imdbId) ?? null,
    },
    { headers: NO_STORE },
  );
}
