import { getFullItem } from "@/lib/jellyfin";
import { getFeatureSubtitleCount, isOpenSubtitlesConfigured } from "@/lib/opensubtitles";
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

    const item = await getFullItem(body.itemId);
    const providerIds = item.ProviderIds as Record<string, string> | undefined;
    const imdbId = providerIds?.Imdb;
    if (!imdbId) {
      return Response.json({ count: null }, { headers: NO_STORE });
    }

    const count = await getFeatureSubtitleCount(imdbId.replace(/^tt/, ""), "en");
    return Response.json({ count: count?.forLanguage ?? 0 }, { headers: NO_STORE });
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
