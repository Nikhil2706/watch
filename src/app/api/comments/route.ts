import { addComment, getRatingSummary, getUserRating, listComments } from "@/lib/community";
import { checkRateLimit, COMMENT_LIMIT, rateLimitHeaders } from "@/lib/ratelimit";
import { getSessionFromRequest } from "@/lib/session";
import { optionalString, readJsonBody, ValidationError } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;
const MAX_TITLE_CHARS = 300;
const MAX_HREF_CHARS = 200;

/**
 * GET /api/comments?imdbId=  — everything CommunitySection needs to render:
 * the comment tree, the rating summary, and the caller's own rating.
 */
export async function GET(request: Request): Promise<Response> {
  const session = getSessionFromRequest(request);
  if (!session) {
    return Response.json({ error: "unauthenticated", message: "Sign in to continue." }, { status: 401, headers: NO_STORE });
  }

  const imdbId = new URL(request.url).searchParams.get("imdbId");
  if (!imdbId) {
    return Response.json({ error: "invalid_request", message: "imdbId is required." }, { status: 400, headers: NO_STORE });
  }

  return Response.json(
    {
      comments: listComments(imdbId),
      rating: getRatingSummary(imdbId),
      yourRating: getUserRating(imdbId, session.userId),
    },
    { headers: NO_STORE },
  );
}

/**
 * POST /api/comments  { imdbId, body, parentId?, filmTitle, filmHref }
 *
 * filmTitle/filmHref are only ever used to label a reply notification
 * (see src/lib/notifications.ts for why they're supplied by the caller
 * rather than looked up here) — the comment itself is stored under imdbId
 * alone, same as every other Community table.
 */
export async function POST(request: Request): Promise<Response> {
  const session = getSessionFromRequest(request);
  if (!session) {
    return Response.json({ error: "unauthenticated", message: "Sign in to continue." }, { status: 401, headers: NO_STORE });
  }

  const limit = checkRateLimit(COMMENT_LIMIT, session.sessionId);
  if (!limit.allowed) {
    return Response.json(
      { error: "rate_limited", message: `Slow down a little — try again in ${limit.retryAfterSeconds} seconds.` },
      { status: 429, headers: { ...NO_STORE, ...rateLimitHeaders(COMMENT_LIMIT, limit) } },
    );
  }

  try {
    const raw = await readJsonBody(request);
    const imdbId = optionalString(raw, "imdbId");
    const body = optionalString(raw, "body");
    const parentId = optionalString(raw, "parentId");
    const filmTitle = optionalString(raw, "filmTitle");
    const filmHref = optionalString(raw, "filmHref");
    if (!imdbId) throw new ValidationError("imdbId is required.");
    if (!body) throw new ValidationError("body is required.");
    if (!filmTitle || !filmHref) throw new ValidationError("filmTitle and filmHref are required.");
    if (!filmHref.startsWith("/item/") && !filmHref.startsWith("/collection/")) {
      throw new ValidationError("filmHref must be a film or show page on this site.");
    }

    const created = addComment({
      imdbId,
      userId: session.userId,
      body,
      parentId: parentId ?? null,
      filmTitle: filmTitle.slice(0, MAX_TITLE_CHARS),
      filmHref: filmHref.slice(0, MAX_HREF_CHARS),
    });

    return Response.json({ ok: true, id: created.id }, { status: 201, headers: NO_STORE });
  } catch (error) {
    if (error instanceof ValidationError) {
      return Response.json({ error: "invalid_request", message: error.message }, { status: 400, headers: NO_STORE });
    }
    console.error("[comments] post failed:", error);
    return Response.json({ error: "internal_error", message: "Could not post that." }, { status: 500, headers: NO_STORE });
  }
}
