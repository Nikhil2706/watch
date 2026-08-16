import { requireAdmin } from "@/lib/admin-auth";
import { createGroup } from "@/lib/library-curation";
import { optionalString, readJsonBody, ValidationError } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * POST /api/admin/library/group
 * Body: { name, paths: string[] } -> creates a group.
 *
 * A database row per path, not a Jellyfin Collection — grouping is a
 * presentation decision, so it lives in this app's own database like
 * exclude does. The browse page hides every grouped path from the main grid
 * and shows one tile in its place, linking to /collection/{groupId}.
 */
export async function POST(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  try {
    const body = await readJsonBody(request);
    const name = optionalString(body, "name");
    const paths = body.paths;
    if (!name || !Array.isArray(paths) || paths.length < 2) {
      throw new ValidationError("name and at least 2 paths are required.");
    }
    if (!paths.every((p) => typeof p === "string")) {
      throw new ValidationError("paths must all be strings.");
    }

    const groupId = createGroup(name, paths as string[]);
    return Response.json({ groupId }, { status: 201, headers: NO_STORE });
  } catch (error) {
    if (error instanceof ValidationError) {
      return Response.json(
        { error: "invalid_request", message: error.message },
        { status: 400, headers: NO_STORE },
      );
    }
    console.error("[admin/library/group] failed:", error);
    return Response.json(
      { error: "internal_error", message: "Could not create the group." },
      { status: 500, headers: NO_STORE },
    );
  }
}
