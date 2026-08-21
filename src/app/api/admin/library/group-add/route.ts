import { requireAdmin } from "@/lib/admin-auth";
import { addToGroup } from "@/lib/library-curation";
import { reconcileGroupSlots } from "@/lib/rollout";
import { optionalString, readJsonBody, ValidationError } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * POST /api/admin/library/group-add
 * Body: { groupId, paths: string[] } -> adds to an EXISTING group.
 *
 * The original "Group checked as one" action (POST .../group) only ever
 * creates a brand-new group — this is the one that exists specifically so
 * a curator can keep adding a scheduled show's later episodes as they
 * arrive (see DESIGN-scheduled-rollout.md's "declare the total up front"
 * requirement), without recreating the group or losing its rollout plan,
 * series link, or overview.
 */
export async function POST(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  try {
    const body = await readJsonBody(request);
    const groupId = optionalString(body, "groupId");
    const paths = body.paths;
    if (!groupId || !Array.isArray(paths) || paths.length === 0) {
      throw new ValidationError("groupId and at least 1 path are required.");
    }
    if (!paths.every((p) => typeof p === "string")) {
      throw new ValidationError("paths must all be strings.");
    }

    const added = addToGroup(groupId, paths as string[]);
    reconcileGroupSlots(groupId);

    return Response.json({ added }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof ValidationError) {
      return Response.json(
        { error: "invalid_request", message: error.message },
        { status: 400, headers: NO_STORE },
      );
    }
    console.error("[admin/library/group-add] failed:", error);
    return Response.json(
      { error: "internal_error", message: "Could not add to the group." },
      { status: 500, headers: NO_STORE },
    );
  }
}
