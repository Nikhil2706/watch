import { requireAdmin } from "@/lib/admin-auth";
import { whitelistPath } from "@/lib/library-curation";
import { optionalString, readJsonBody, ValidationError } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * POST /api/admin/library/whitelist
 * Body: { path } -> "show this on the front end anyway", overriding the
 * default hide-if-no-metadata rule. A database row, same as exclude — no
 * Jellyfin call, no file touched.
 */
export async function POST(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  try {
    const body = await readJsonBody(request);
    const path = optionalString(body, "path");
    if (!path) throw new ValidationError("path is required.");

    whitelistPath(path);
    return Response.json({ whitelisted: true, path }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof ValidationError) {
      return Response.json(
        { error: "invalid_request", message: error.message },
        { status: 400, headers: NO_STORE },
      );
    }
    console.error("[admin/library/whitelist] failed:", error);
    return Response.json(
      { error: "internal_error", message: "Could not whitelist that item." },
      { status: 500, headers: NO_STORE },
    );
  }
}
