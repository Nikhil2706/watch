import { requireAdmin } from "@/lib/admin-auth";
import { renameGroup } from "@/lib/library-curation";
import { optionalString, readJsonBody, ValidationError } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** POST /api/admin/library/group-rename — Body: { groupId, name }. */
export async function POST(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  try {
    const body = await readJsonBody(request);
    const groupId = optionalString(body, "groupId");
    const name = optionalString(body, "name");
    if (!groupId || !name) throw new ValidationError("groupId and name are required.");

    const found = renameGroup(groupId, name);
    if (!found) {
      return Response.json(
        { error: "not_found", message: "No such group." },
        { status: 404, headers: NO_STORE },
      );
    }
    return Response.json({ renamed: true }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof ValidationError) {
      return Response.json(
        { error: "invalid_request", message: error.message },
        { status: 400, headers: NO_STORE },
      );
    }
    console.error("[admin/library/group-rename] failed:", error);
    return Response.json(
      { error: "internal_error", message: "Could not rename the group." },
      { status: 500, headers: NO_STORE },
    );
  }
}
