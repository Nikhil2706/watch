import { requireAdmin } from "@/lib/admin-auth";
import { env } from "@/lib/env";
import { listFolderRemovals, markFolderForRemoval, unmarkFolderForRemoval } from "@/lib/folder-removals";
import { toLibraryPath } from "@/lib/library-folders";
import { optionalString, readJsonBody, ValidationError } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * GET /api/admin/library/removals
 *
 * The folders marked to be deleted, soonest first, with how many titles
 * each holds.
 */
export async function GET(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;
  return Response.json({ removals: await listFolderRemovals() }, { headers: NO_STORE });
}

/**
 * POST /api/admin/library/removals
 *   { action: "mark", folder }     the folder and everything in it is deleted thirty days from now
 *   { action: "unmark", folder }   takes that back
 *
 * `folder` is the part under the library ("Horror/Wolf Creek"), as the
 * folders route lists it. Marking deletes nothing: until the date, it only
 * makes the films inside say they are leaving.
 */
export async function POST(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  try {
    const body = await readJsonBody(request);
    const action = optionalString(body, "action");
    const folder = optionalString(body, "folder");
    if (!folder) throw new ValidationError("folder is required.");
    const path = toLibraryPath(folder, env.mediaLibraryPath, env.hostMediaPath);
    if (!path) throw new ValidationError("That is not a folder in the library.");

    if (action === "mark") {
      try {
        return Response.json({ marked: true, ...markFolderForRemoval(path) }, { headers: NO_STORE });
      } catch {
        throw new ValidationError("The library itself cannot be marked, only a folder inside it.");
      }
    }
    if (action === "unmark") {
      return Response.json({ unmarked: unmarkFolderForRemoval(path) }, { headers: NO_STORE });
    }
    throw new ValidationError("action must be mark or unmark.");
  } catch (error) {
    if (error instanceof ValidationError) {
      return Response.json({ error: "invalid_request", message: error.message }, { status: 400, headers: NO_STORE });
    }
    console.error("[admin/library/removals] failed:", error);
    return Response.json({ error: "internal_error", message: "Could not do that." }, { status: 500, headers: NO_STORE });
  }
}
