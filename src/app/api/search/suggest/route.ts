import { getSessionFromRequest } from "@/lib/session";
import { smartSearch, toSearchHit } from "@/lib/media";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * GET /api/search/suggest?q=...
 *
 * Feeds the type-ahead. Returns a poster URL and a short reason for each hit so
 * the dropdown can show why something matched — "Cast: Margot Robbie" is far
 * more useful than an unexplained result when the query was not a title.
 */
export async function GET(request: Request): Promise<Response> {
  const session = getSessionFromRequest(request);
  if (!session) {
    return Response.json(
      { error: "unauthenticated" },
      { status: 401, headers: NO_STORE },
    );
  }

  const query = new URL(request.url).searchParams.get("q") ?? "";
  if (query.trim().length < 2) {
    return Response.json({ results: [] }, { headers: NO_STORE });
  }

  try {
    const matches = await smartSearch(session, query, 8);
    return Response.json({ results: matches.map(toSearchHit) }, { headers: NO_STORE });
  } catch (error) {
    console.error("[search/suggest] failed:", error);
    return Response.json({ results: [] }, { headers: NO_STORE });
  }
}
