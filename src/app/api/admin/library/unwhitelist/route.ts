import { requireAdmin } from "@/lib/admin-auth";
import { unwhitelistPath } from "@/lib/library-curation";
import { optionalString, readJsonBody, ValidationError } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** POST /api/admin/library/unwhitelist — Body: { path }. Undoes a whitelist; the item hides again if it still has no metadata. */
export async function POST(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  try {
    const body = await readJsonBody(request);
    const path = optionalString(body, "path");
    if (!path) throw new ValidationError("path is required.");

    const found = unwhitelistPath(path);
    return Response.json({ unwhitelisted: found }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof ValidationError) {
      return Response.json(
        { error: "invalid_request", message: error.message },
        { status: 400, headers: NO_STORE },
      );
    }
    console.error("[admin/library/unwhitelist] failed:", error);
    return Response.json(
      { error: "internal_error", message: "Could not undo that whitelist." },
      { status: 500, headers: NO_STORE },
    );
  }
}
