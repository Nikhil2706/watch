import { requireAdmin } from "@/lib/admin-auth";
import { removeFromGroup } from "@/lib/library-curation";
import { optionalString, readJsonBody, ValidationError } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * POST /api/admin/library/remove-from-group — Body: { path }.
 *
 * Pulls one file out of a group without excluding it — it goes back to
 * showing as its own tile on Browse. Different from Exclude, which hides it
 * entirely; this is for "this file doesn't belong in this group," not
 * "don't show this at all."
 */
export async function POST(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  try {
    const body = await readJsonBody(request);
    const path = optionalString(body, "path");
    if (!path) throw new ValidationError("path is required.");

    const found = removeFromGroup(path);
    return Response.json({ removed: found }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof ValidationError) {
      return Response.json(
        { error: "invalid_request", message: error.message },
        { status: 400, headers: NO_STORE },
      );
    }
    console.error("[admin/library/remove-from-group] failed:", error);
    return Response.json(
      { error: "internal_error", message: "Could not remove that item from the group." },
      { status: 500, headers: NO_STORE },
    );
  }
}
