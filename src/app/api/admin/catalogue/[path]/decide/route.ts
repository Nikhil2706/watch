import { requireAdmin } from "@/lib/admin-auth";
import { parseDecision } from "@/lib/catalogue-decide";
import { decide, DecisionError } from "@/lib/catalogue-decisions";
import { readJsonBody, ValidationError } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * POST /api/admin/catalogue/{path}/decide — one decision about one file
 * (docs/catalogue-state.md, 3.4). `{path}` is the file's path, URL-encoded as
 * one segment. Body: `{ action, reason?, ...params }`:
 *
 *   show_anyway  { reason?: "damaged" | "no_metadata" }   (none: every reason that has it)
 *   take_off     { reason: "damaged" | "no_metadata" }
 *   hide         { note? }            unhide
 *   replace_recheck                   accept_suggestion
 *   place_as     { as: "film" }
 *                { as: "episode", groupId | seriesKey }
 *                { as: "special_feature", target?: { kind, id } }
 *                { as: "version", of: <path>, label? }
 *
 * -> `{ path, state }`: the file's new catalogue state, so one card can be
 * redrawn. Every action is idempotent, and goes through the same function the
 * older endpoint for it calls; those endpoints still work, and log too.
 */
export async function POST(request: Request, { params }: { params: Promise<{ path: string }> }): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  try {
    const { path: segment } = await params;
    // Next has already decoded the segment once; a path holding "%" was sent
    // encoded twice and is decoded here once more only if that is what it is.
    const path = segment.startsWith("/") ? segment : decodeURIComponent(segment);
    if (!path.startsWith("/")) throw new ValidationError("The path must be the file's full path.");

    const decision = parseDecision(await readJsonBody(request));
    if (typeof decision === "string") throw new ValidationError(decision);

    const result = await decide(path, decision);
    return Response.json(result, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof ValidationError || error instanceof DecisionError) {
      const status = error instanceof DecisionError ? error.status : 400;
      return Response.json(
        { error: status === 404 ? "not_found" : "invalid_request", message: error.message },
        { status, headers: NO_STORE },
      );
    }
    console.error("[admin/catalogue/decide] failed:", error);
    return Response.json(
      { error: "internal_error", message: error instanceof Error ? error.message : "Could not do that." },
      { status: 500, headers: NO_STORE },
    );
  }
}
