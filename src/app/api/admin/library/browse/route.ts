import { requireAdmin } from "@/lib/admin-auth";
import { asRow, getDb } from "@/lib/db";
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
    // The workspace loads this on arrival and says when the library was last
    // scanned, so the scan button reads as part of the same picture rather
    // than an unrelated action sitting above it.
    const scan = asRow<{ triggered_at: number }>(
      getDb().prepare("SELECT triggered_at FROM health_last_scan WHERE id = 1").get(),
    );
    return Response.json(
      { items, lastScanAt: scan?.triggered_at ?? null },
      { headers: NO_STORE },
    );
  } catch (error) {
    console.error("[admin/library/browse] failed:", error);
    return Response.json(
      { error: "internal_error", message: "Could not load the library." },
      { status: 500, headers: NO_STORE },
    );
  }
}
