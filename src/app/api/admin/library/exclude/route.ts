import { requireAdmin } from "@/lib/admin-auth";
import { excludePath } from "@/lib/library-curation";
import { optionalString, readJsonBody, ValidationError } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * POST /api/admin/library/exclude
 * Body: { path } -> hides this file from the front end.
 *
 * A database row, not a file move: Da Moveesh is never touched. Instant, and
 * exactly as reversible as any other row — DELETE it (or use /unexclude) and
 * the item is back on the next page load, no rescan needed.
 */
export async function POST(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  try {
    const body = await readJsonBody(request);
    const path = optionalString(body, "path");
    if (!path) throw new ValidationError("path is required.");
    const reason = optionalString(body, "reason");

    excludePath(path, reason);
    return Response.json({ excluded: true, path }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof ValidationError) {
      return Response.json(
        { error: "invalid_request", message: error.message },
        { status: 400, headers: NO_STORE },
      );
    }
    console.error("[admin/library/exclude] failed:", error);
    return Response.json(
      { error: "internal_error", message: "Could not exclude that item." },
      { status: 500, headers: NO_STORE },
    );
  }
}
