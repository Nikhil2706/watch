import { getItem } from "@/lib/media";
import { getCachedSubtitleCount, isOpenSubtitlesConfigured } from "@/lib/opensubtitles";
import { checkRateLimit, rateLimitHeaders, SUBTITLE_CHECK_LIMIT } from "@/lib/ratelimit";
import { getSessionFromRequest } from "@/lib/session";
import { readJsonBody, ValidationError } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * POST /api/subtitles/check  { itemId }
 *
 * "How many subtitles does OpenSubtitles have for this, before I commit to
 * fetching one?" — OpenSubtitles' /features endpoint, not /download, so it
 * never touches the shared daily download quota. Used by
 * FetchSubtitlesButton to show a real count (or hide the button entirely
 * when the answer is zero) instead of a viewer clicking blind.
 *
 * getCachedSubtitleCount() (opensubtitles.ts) does the actual caching — see
 * its own comment for why: /features has a 40-requests/10-seconds cap
 * shared across this app's entire Api-Key, not per user.
 */
export async function POST(request: Request): Promise<Response> {
  const session = getSessionFromRequest(request);
  if (!session) {
    return Response.json(
      { error: "unauthenticated", message: "Sign in to continue." },
      { status: 401, headers: NO_STORE },
    );
  }

  if (!isOpenSubtitlesConfigured()) {
    return Response.json({ count: null }, { headers: NO_STORE });
  }

  const limit = checkRateLimit(SUBTITLE_CHECK_LIMIT, session.userId);
  if (!limit.allowed) {
    return Response.json(
      { error: "rate_limited", message: "Too many requests." },
      { status: 429, headers: { ...NO_STORE, ...rateLimitHeaders(SUBTITLE_CHECK_LIMIT, limit) } },
    );
  }

  try {
    const body = await readJsonBody(request);
    if (typeof body.itemId !== "string" || body.itemId === "") {
      throw new ValidationError("itemId is required.");
    }

    // Session-scoped, not the admin-key getFullItem(): otherwise a viewer
    // under parental control could confirm a restricted title exists (and how
    // many subtitles it has) through an endpoint the rest of the app would
    // never show them. getItem() returns null for restricted-or-missing alike.
    const item = await getItem(session, body.itemId);
    if (!item) {
      return Response.json(
        { error: "not_found", message: "No such item." },
        { status: 404, headers: NO_STORE },
      );
    }

    const imdbId = item.ProviderIds?.Imdb;
    if (!imdbId) {
      return Response.json({ count: null }, { headers: NO_STORE });
    }

    const count = await getCachedSubtitleCount(imdbId, "en");
    return Response.json({ count }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof ValidationError) {
      return Response.json(
        { error: "invalid_request", message: error.message },
        { status: 400, headers: NO_STORE },
      );
    }
    // Availability info only — a failure here shouldn't block the fetch
    // button itself, just fall back to "unknown" rather than an error state.
    console.error("[subtitles/check] failed:", error);
    return Response.json({ count: null }, { headers: NO_STORE });
  }
}
