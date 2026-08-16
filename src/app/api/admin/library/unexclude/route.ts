import { requireAdmin } from "@/lib/admin-auth";
import { unexcludePath } from "@/lib/library-curation";
import { optionalString, readJsonBody, ValidationError } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** POST /api/admin/library/unexclude — Body: { path }. Undoes an exclude; the item reappears immediately. */
export async function POST(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  try {
    const body = await readJsonBody(request);
    const path = optionalString(body, "path");
    if (!path) throw new ValidationError("path is required.");

    const found = unexcludePath(path);
    return Response.json({ unexcluded: found }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof ValidationError) {
      return Response.json(
        { error: "invalid_request", message: error.message },
        { status: 400, headers: NO_STORE },
      );
    }
    console.error("[admin/library/unexclude] failed:", error);
    return Response.json(
      { error: "internal_error", message: "Could not undo that exclusion." },
      { status: 500, headers: NO_STORE },
    );
  }
}
