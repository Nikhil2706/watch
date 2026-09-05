import { requireAdmin } from "@/lib/admin-auth";
import { refreshAdminMovie } from "@/lib/admin-library-cache";
import { setManualMetadata } from "@/lib/jellyfin";
import { markMetadataConfirmed } from "@/lib/library-curation";
import { optionalInt, optionalString, readJsonBody, ValidationError } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * POST /api/admin/library/manual-metadata
 * Body: { itemId, name?, overview?, year? }
 *
 * For the content that will never have a real match — a home recording, a
 * YouTube rip — hand-writes the fields Jellyfin couldn't find and locks them
 * so the next scan doesn't blank them out again.
 */
export async function POST(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  try {
    const body = await readJsonBody(request);
    const itemId = optionalString(body, "itemId");
    const path = optionalString(body, "path");
    if (!itemId) throw new ValidationError("itemId is required.");

    const name = optionalString(body, "name");
    const overviewRaw = body.overview;
    const overview =
      overviewRaw === undefined || overviewRaw === null
        ? undefined
        : typeof overviewRaw === "string"
          ? overviewRaw.slice(0, 2000)
          : (() => {
              throw new ValidationError("overview must be a string.");
            })();
    const year = optionalInt(body, "year");

    if (name === undefined && overview === undefined && year === undefined) {
      throw new ValidationError("At least one of name, overview, year is required.");
    }

    await setManualMetadata(itemId, { name, overview, year });

    // Same reasoning as apply-match: the cached listing is now behind, and
    // only this one row of it.
    await refreshAdminMovie(itemId);
    if (path) markMetadataConfirmed(path);
    return Response.json({ saved: true }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof ValidationError) {
      return Response.json(
        { error: "invalid_request", message: error.message },
        { status: 400, headers: NO_STORE },
      );
    }
    console.error("[admin/library/manual-metadata] failed:", error);
    return Response.json(
      { error: "internal_error", message: "Could not save metadata." },
      { status: 500, headers: NO_STORE },
    );
  }
}
