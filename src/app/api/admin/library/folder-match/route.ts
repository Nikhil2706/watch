import { requireAdmin } from "@/lib/admin-auth";
import {
  acceptFolderSuggestion,
  dismissFolderSuggestion,
  folderMatchRunning,
  listFolderSuggestions,
  runFolderMatch,
} from "@/lib/folder-match";
import { optionalBoolean, optionalString, readJsonBody, ValidationError } from "@/lib/validation";
import { logDecision } from "@/lib/catalogue-decisions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * GET /api/admin/library/folder-match
 *
 * What the folders have said about unidentified files: the suggestions
 * waiting for a yes or no, and the last few applied without asking.
 */
export async function GET(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;
  return Response.json({ ...listFolderSuggestions(), running: folderMatchRunning() }, { headers: NO_STORE });
}

/**
 * POST /api/admin/library/folder-match
 *   { action: "run", apply?: boolean }   look at every unidentified file; `apply` false stores suggestions only
 *   { action: "accept", path }           apply one suggestion
 *   { action: "dismiss", path }          turn one down, for good
 */
export async function POST(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  try {
    const body = await readJsonBody(request);
    const action = optionalString(body, "action");
    const path = optionalString(body, "path");

    if (action === "run") {
      const run = await runFolderMatch({ apply: optionalBoolean(body, "apply") ?? true });
      return Response.json({ run, ...listFolderSuggestions() }, { headers: NO_STORE });
    }
    if (action === "accept" || action === "dismiss") {
      if (!path) throw new ValidationError("path is required.");
      if (action === "dismiss") {
        if (!dismissFolderSuggestion(path)) throw new ValidationError("That suggestion is no longer open.");
        return Response.json({ dismissed: true }, { headers: NO_STORE });
      }
      const applied = await acceptFolderSuggestion(path);
      logDecision({ path, action: "accept_suggestion" });
      return Response.json({ applied }, { headers: NO_STORE });
    }
    throw new ValidationError("action must be run, accept or dismiss.");
  } catch (error) {
    if (error instanceof ValidationError) {
      return Response.json({ error: "invalid_request", message: error.message }, { status: 400, headers: NO_STORE });
    }
    console.error("[admin/library/folder-match] failed:", error);
    return Response.json(
      { error: "internal_error", message: error instanceof Error ? error.message : "Could not do that." },
      { status: 500, headers: NO_STORE },
    );
  }
}
