import { requireAdmin } from "@/lib/admin-auth";
import { buildLibraryReview } from "@/lib/library-review";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * GET /api/admin/library/review
 *
 * Scans the current library for the two problems the dashboard exists to
 * fix: titles that appear more than once (probably the same film twice, in
 * different formats) and movies Jellyfin never matched to any metadata
 * provider at all. Computed fresh on every call — the library is a few
 * hundred items, cheap enough not to bother caching.
 */
export async function GET(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  try {
    const review = await buildLibraryReview();
    return Response.json(review, { headers: NO_STORE });
  } catch (error) {
    console.error("[admin/library/review] failed:", error);
    return Response.json(
      { error: "internal_error", message: "Could not build the library review." },
      { status: 500, headers: NO_STORE },
    );
  }
}
