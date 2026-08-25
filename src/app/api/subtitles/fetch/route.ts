import { checkRateLimit, rateLimitHeaders, SUBTITLE_FETCH_LIMIT } from "@/lib/ratelimit";
import { getSessionFromRequest } from "@/lib/session";
import { fetchSubtitleForItem } from "@/lib/subtitle-fetch";
import { readJsonBody, ValidationError } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * POST /api/subtitles/fetch  { itemId }
 *
 * The consumer-facing counterpart to the curator's Library Review action —
 * shown on the item page only when a title has zero subtitle tracks. Unlike
 * the admin route, this never forces a retry of a previously not_found/error
 * attempt (see fetchSubtitleForItem's `force` param): once a title's been
 * tried and missed, every subsequent viewer sees the same cached "no match"
 * rather than each burning another unit of the shared daily download quota
 * on the same already-known miss.
 */
export async function POST(request: Request): Promise<Response> {
  const session = getSessionFromRequest(request);
  if (!session) {
    return Response.json(
      { error: "unauthenticated", message: "Sign in to continue." },
      { status: 401, headers: NO_STORE },
    );
  }

  const limit = checkRateLimit(SUBTITLE_FETCH_LIMIT, session.userId);
  if (!limit.allowed) {
    return Response.json(
      {
        error: "rate_limited",
        message: `Too many subtitle requests. Try again in ${limit.retryAfterSeconds} seconds.`,
      },
      { status: 429, headers: { ...NO_STORE, ...rateLimitHeaders(SUBTITLE_FETCH_LIMIT, limit) } },
    );
  }

  try {
    const body = await readJsonBody(request);
    if (typeof body.itemId !== "string" || body.itemId === "") {
      throw new ValidationError("itemId is required.");
    }

    const result = await fetchSubtitleForItem(body.itemId, session.userId, false);
    return Response.json(result, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof ValidationError) {
      return Response.json(
        { error: "invalid_request", message: error.message },
        { status: 400, headers: NO_STORE },
      );
    }
    console.error("[subtitles/fetch] failed:", error);
    return Response.json(
      { error: "internal_error", message: "Could not fetch subtitles for that item." },
      { status: 500, headers: NO_STORE },
    );
  }
}
