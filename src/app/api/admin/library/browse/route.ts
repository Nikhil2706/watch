import { requireAdmin } from "@/lib/admin-auth";
import { buildLibraryBrowse } from "@/lib/library-review";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * GET /api/admin/library/browse
 *
 * Every movie, flat, with the flags the redesigned Library tab needs to
 * search/filter/sort client-side without a round-trip per keystroke — a
 * personal-scale library is cheap enough to ship whole and let the browser
 * do the filtering.
 */
export async function GET(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  try {
    const items = await buildLibraryBrowse();
    return Response.json({ items }, { headers: NO_STORE });
  } catch (error) {
    console.error("[admin/library/browse] failed:", error);
    return Response.json(
      { error: "internal_error", message: "Could not load the library." },
      { status: 500, headers: NO_STORE },
    );
  }
}
