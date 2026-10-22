import { requireAdmin } from "@/lib/admin-auth";
import { invalidate } from "@/lib/cache";
import { fileCheckProgress, requestRecheck, setDamagedAllowed } from "@/lib/file-checks";
import { optionalString, readJsonBody, ValidationError } from "@/lib/validation";
import { logDecision } from "@/lib/catalogue-decisions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * GET /api/admin/library/file-check
 *
 * How far the worker has got through reading every file for damage: how
 * many checked, how many found damaged or with a minor fault.
 */
export async function GET(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;
  return Response.json(fileCheckProgress(), { headers: NO_STORE });
}

/**
 * POST /api/admin/library/file-check
 *   { action: "allow", path }     show a damaged file on the site anyway
 *   { action: "disallow", path }  take that back
 *   { action: "recheck", path }   forget the result; the worker reads the file again
 */
export async function POST(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;
  try {
    const body = await readJsonBody(request);
    const action = optionalString(body, "action");
    const path = optionalString(body, "path");
    if (!path) throw new ValidationError("path is required.");
    let ok: boolean;
    if (action === "allow" || action === "disallow") ok = setDamagedAllowed(path, action === "allow");
    else if (action === "recheck") ok = requestRecheck(path);
    else throw new ValidationError("action must be allow, disallow or recheck.");
    if (!ok) throw new ValidationError("That file has no check on record.");
    if (action === "recheck") logDecision({ path, action: "replace_recheck" });
    else logDecision({ path, action: action === "allow" ? "show_anyway" : "take_off", reason: "damaged" });
    // The listing viewers read is cached for a minute; what is hidden just changed.
    invalidate("all-movies");
    return Response.json({ ok: true }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof ValidationError) {
      return Response.json({ error: "invalid_request", message: error.message }, { status: 400, headers: NO_STORE });
    }
    console.error("[admin/library/file-check] failed:", error);
    return Response.json({ error: "internal_error", message: "Could not do that." }, { status: 500, headers: NO_STORE });
  }
}
