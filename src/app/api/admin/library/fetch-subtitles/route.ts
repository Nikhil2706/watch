import { requireAdmin } from "@/lib/admin-auth";
import { fetchSubtitleForItem } from "@/lib/subtitle-fetch";
import { optionalString, readJsonBody, ValidationError } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * POST /api/admin/library/fetch-subtitles
 * Body: { itemId } -> searches OpenSubtitles by this title's IMDb id and, on
 * a match, downloads and writes an external .srt next to the video, then
 * refreshes the item in Jellyfin so it shows up immediately. Called from
 * the Library Review "Missing subtitles" panel; always `force`s past a
 * previous not_found/error attempt, since a curator clicking this again is
 * explicitly asking for a retry.
 */
export async function POST(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  try {
    const body = await readJsonBody(request);
    const itemId = optionalString(body, "itemId");
    if (!itemId) throw new ValidationError("itemId is required.");

    const result = await fetchSubtitleForItem(itemId, "curator", true);
    return Response.json(result, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof ValidationError) {
      return Response.json(
        { error: "invalid_request", message: error.message },
        { status: 400, headers: NO_STORE },
      );
    }
    console.error("[admin/library/fetch-subtitles] failed:", error);
    return Response.json(
      { error: "internal_error", message: "Could not fetch subtitles for that item." },
      { status: 500, headers: NO_STORE },
    );
  }
}
