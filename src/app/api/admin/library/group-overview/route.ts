import { requireAdmin } from "@/lib/admin-auth";
import { setGroupOverview } from "@/lib/library-curation";
import { optionalString, readJsonBody, ValidationError } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * POST /api/admin/library/group-overview
 * Body: { groupId, overview }
 *
 * A group has no Jellyfin item of its own to hold a synopsis, so it lives
 * here — the collection page reads it back via getCollection.
 */
export async function POST(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  try {
    const body = await readJsonBody(request);
    const groupId = optionalString(body, "groupId");
    if (!groupId) throw new ValidationError("groupId is required.");

    const overviewRaw = body.overview;
    if (typeof overviewRaw !== "string") throw new ValidationError("overview must be a string.");

    setGroupOverview(groupId, overviewRaw.slice(0, 2000));
    return Response.json({ saved: true }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof ValidationError) {
      return Response.json(
        { error: "invalid_request", message: error.message },
        { status: 400, headers: NO_STORE },
      );
    }
    console.error("[admin/library/group-overview] failed:", error);
    return Response.json(
      { error: "internal_error", message: "Could not save the overview." },
      { status: 500, headers: NO_STORE },
    );
  }
}
