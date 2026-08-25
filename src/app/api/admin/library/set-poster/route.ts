import { requireAdmin } from "@/lib/admin-auth";
import { setItemImage } from "@/lib/jellyfin";
import { optionalString, readJsonBody, ValidationError } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * POST /api/admin/library/set-poster
 * Body: { itemId, imageUrl } -> applies a chosen TMDB poster as the item's
 * Primary image. Reuses setItemImage(), the same Jellyfin call the episode-
 * fetch flow already uses to replace a mismatched poster with the real one
 * from OMDb — this is the same action, just triggered from Library Review's
 * poster picker instead.
 */
export async function POST(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  try {
    const body = await readJsonBody(request);
    const itemId = optionalString(body, "itemId");
    const imageUrl = optionalString(body, "imageUrl");
    if (!itemId) throw new ValidationError("itemId is required.");
    if (!imageUrl) throw new ValidationError("imageUrl is required.");

    await setItemImage(itemId, imageUrl);
    return Response.json({ ok: true }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof ValidationError) {
      return Response.json(
        { error: "invalid_request", message: error.message },
        { status: 400, headers: NO_STORE },
      );
    }
    console.error("[admin/library/set-poster] failed:", error);
    return Response.json(
      { error: "internal_error", message: "Could not set that poster." },
      { status: 500, headers: NO_STORE },
    );
  }
}
