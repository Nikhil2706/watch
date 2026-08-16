import { requireAdmin } from "@/lib/admin-auth";
import { listExcluded, listGroups, listWhitelisted } from "@/lib/library-curation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * GET /api/admin/library/curation
 *
 * The whole document: every exclude, group and whitelist decision made from
 * the review dashboard so far, with nothing filtered out — this is what lets
 * an admin see and undo past decisions, not just make new ones.
 */
export async function GET(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  try {
    return Response.json(
      { excluded: listExcluded(), groups: listGroups(), whitelisted: listWhitelisted() },
      { headers: NO_STORE },
    );
  } catch (error) {
    console.error("[admin/library/curation] failed:", error);
    return Response.json(
      { error: "internal_error", message: "Could not load curation state." },
      { status: 500, headers: NO_STORE },
    );
  }
}
