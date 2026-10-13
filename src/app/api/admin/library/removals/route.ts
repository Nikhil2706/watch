import { requireAdmin } from "@/lib/admin-auth";
import { env } from "@/lib/env";
import {
  listFolderRemovals,
  listKeptWriteups,
  markFolderForRemoval,
  syncLeavingPick,
  unmarkFolderForRemoval,
} from "@/lib/folder-removals";
import { toLibraryPath } from "@/lib/library-folders";
import { optionalString, readJsonBody, ValidationError } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * GET /api/admin/library/removals
 *
 * The folders marked to be deleted, soonest first, with how many titles
 * each holds; and `kept`, what was written in the Leaving soon pick about
 * titles that have since left it.
 */
export async function GET(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;
  return Response.json({ removals: await listFolderRemovals(), kept: listKeptWriteups() }, { headers: NO_STORE });
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
        const marked = markFolderForRemoval(path);
        // Not awaited: marking has to stay as fast as pressing, and the pick
        // catching up a moment later is soon enough.
        void syncLeavingPick().catch((error) => console.error("[removals] leaving pick not updated:", error));
        return Response.json({ marked: true, ...marked }, { headers: NO_STORE });
      } catch {
        throw new ValidationError("The library itself cannot be marked, only a folder inside it.");
      }
    }
    if (action === "unmark") {
      const unmarked = unmarkFolderForRemoval(path);
      void syncLeavingPick().catch((error) => console.error("[removals] leaving pick not updated:", error));
      return Response.json({ unmarked }, { headers: NO_STORE });
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
