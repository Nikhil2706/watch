import { requireAdmin } from "@/lib/admin-auth";
import { ungroup } from "@/lib/library-curation";
import { optionalString, readJsonBody, ValidationError } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** POST /api/admin/library/ungroup — Body: { groupId }. Dissolves a group; its members return to the main grid individually. */
export async function POST(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  try {
    const body = await readJsonBody(request);
    const groupId = optionalString(body, "groupId");
    if (!groupId) throw new ValidationError("groupId is required.");

    const found = ungroup(groupId);
    return Response.json({ ungrouped: found }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof ValidationError) {
      return Response.json(
        { error: "invalid_request", message: error.message },
        { status: 400, headers: NO_STORE },
      );
    }
    console.error("[admin/library/ungroup] failed:", error);
    return Response.json(
      { error: "internal_error", message: "Could not dissolve that group." },
      { status: 500, headers: NO_STORE },
    );
  }
}
