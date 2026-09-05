import { requireAdmin } from "@/lib/admin-auth";
import { invalidateAdminMovies } from "@/lib/admin-library-cache";
import { mergeVersions } from "@/lib/jellyfin";
import { readJsonBody, ValidationError } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * POST /api/admin/library/merge-versions
 * Body: { itemIds: string[] } -> merges 2+ items as Jellyfin's own native
 * "alternate versions" of one movie (e.g. an American cut and an Italian
 * cut), not a duplicate to discard. See mergeVersions() in jellyfin.ts.
 */
export async function POST(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  try {
    const body = await readJsonBody(request);
    const itemIds = body.itemIds;
    if (!Array.isArray(itemIds) || itemIds.length < 2) {
      throw new ValidationError("itemIds must be an array of at least 2 item ids.");
    }
    if (!itemIds.every((id) => typeof id === "string")) {
      throw new ValidationError("itemIds must all be strings.");
    }

    await mergeVersions(itemIds as string[]);

    // Merging changes which items exist at all, so the cached listing is now
    // describing files that are no longer separate.
    invalidateAdminMovies();
    return Response.json({ merged: true }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof ValidationError) {
      return Response.json(
        { error: "invalid_request", message: error.message },
        { status: 400, headers: NO_STORE },
      );
    }
    console.error("[admin/library/merge-versions] failed:", error);
    return Response.json(
      { error: "internal_error", message: "Could not merge these as versions." },
      { status: 500, headers: NO_STORE },
    );
  }
}
