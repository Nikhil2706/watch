import { requireAdmin } from "@/lib/admin-auth";
import { applyRemoteSearchMatch, type RemoteSearchResult } from "@/lib/jellyfin";
import { markMetadataConfirmed } from "@/lib/library-curation";
import { optionalString, readJsonBody, ValidationError } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * POST /api/admin/library/apply-match
 * Body: { itemId, candidate, path? } -> applies one of /identify's results.
 *
 * `candidate` is passed back exactly as /identify returned it — Jellyfin's
 * Apply endpoint wants the whole RemoteSearchResult object, not just an id,
 * since some providers (OMDb here) don't carry a stable id to re-look-up by.
 *
 * `path`, when the caller already has it, marks the file as admin-confirmed
 * — see library_confirmed_metadata in schema.ts for why.
 */
export async function POST(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  try {
    const body = await readJsonBody(request);
    const itemId = optionalString(body, "itemId");
    const path = optionalString(body, "path");
    const candidate = body.candidate;
    if (!itemId || typeof candidate !== "object" || candidate === null) {
      throw new ValidationError("itemId and candidate are required.");
    }

    await applyRemoteSearchMatch(itemId, candidate as RemoteSearchResult);
    if (path) markMetadataConfirmed(path);
    return Response.json({ applied: true }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof ValidationError) {
      return Response.json(
        { error: "invalid_request", message: error.message },
        { status: 400, headers: NO_STORE },
      );
    }
    console.error("[admin/library/apply-match] failed:", error);
    return Response.json(
      { error: "internal_error", message: "Could not apply that match." },
      { status: 500, headers: NO_STORE },
    );
  }
}
