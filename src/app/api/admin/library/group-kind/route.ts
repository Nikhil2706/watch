import { requireAdmin } from "@/lib/admin-auth";
import { getGroupSeriesId, setGroupKind, type GroupKind } from "@/lib/library-curation";
import { optionalString, readJsonBody, ValidationError } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * POST /api/admin/library/group-kind  { groupId, kind: "series" | "movie" }
 *
 * The curator's override for whether a grouped title reads as "154 episodes"
 * or "8 parts".
 *
 * This exists because OMDb is authoritative about what a title IS and not
 * about what we want to call it: a long film released in instalments (Out 1,
 * Berlin Alexanderplatz) is routinely catalogued as a mini-series, and
 * re-fetching will keep saying so. The series fetch sets this field when it
 * can; this route is how a human wins the argument.
 */
export async function POST(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  try {
    const body = await readJsonBody(request);
    const groupId = optionalString(body, "groupId");
    const kind = optionalString(body, "kind");
    if (!groupId) throw new ValidationError("groupId is required.");
    if (kind !== "series" && kind !== "movie") {
      throw new ValidationError('kind must be "series" or "movie".');
    }

    // kind hangs off the group's series row, so there has to be one. Saying so
    // beats a silent no-op that looks like the toggle simply doesn't work.
    if (!getGroupSeriesId(groupId)) {
      throw new ValidationError(
        "Link this group's series on IMDb first — the kind is stored alongside it.",
      );
    }

    const saved = setGroupKind(groupId, kind as GroupKind);
    if (!saved) throw new ValidationError(`No group with id ${groupId}.`);

    return Response.json({ saved: true, groupId, kind }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof ValidationError) {
      return Response.json({ error: "invalid_request", message: error.message }, { status: 400, headers: NO_STORE });
    }
    console.error("[admin/library/group-kind] failed:", error);
    return Response.json(
      { error: "internal_error", message: "Could not save the kind." },
      { status: 500, headers: NO_STORE },
    );
  }
}
