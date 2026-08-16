import { requireAdmin } from "@/lib/admin-auth";
import { buildGroupDetail } from "@/lib/library-review";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * GET /api/admin/library/group-detail?groupId=...
 *
 * One group's members, episode-ordered, each with its current (possibly
 * wrong) Jellyfin match — the data behind the dashboard's "Manage" panel,
 * where a mis-tagged episode gets corrected the same way a thin-metadata
 * item does (Search / Manual / Exclude), plus Remove-from-group.
 */
export async function GET(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const groupId = new URL(request.url).searchParams.get("groupId");
  if (!groupId) {
    return Response.json(
      { error: "invalid_request", message: "groupId is required." },
      { status: 400, headers: NO_STORE },
    );
  }

  try {
    const detail = await buildGroupDetail(groupId);
    if (!detail) {
      return Response.json(
        { error: "not_found", message: "No such group." },
        { status: 404, headers: NO_STORE },
      );
    }
    return Response.json(detail, { headers: NO_STORE });
  } catch (error) {
    console.error("[admin/library/group-detail] failed:", error);
    return Response.json(
      { error: "internal_error", message: "Could not load the group." },
      { status: 500, headers: NO_STORE },
    );
  }
}
