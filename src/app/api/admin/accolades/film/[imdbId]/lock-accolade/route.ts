import { requireAdmin } from "@/lib/admin-auth";
import { lockAccoladeEntry, lockAccoladeLink, unlockAccolade } from "@/lib/scraping/locks";
import { optionalString, readJsonBody, ValidationError } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * POST /api/admin/accolades/film/{imdbId}/lock-accolade
 *   { link_id } to lock a scraped accolade mention, or
 *   { entry_id } to lock one of the curator's own built-list entries.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ imdbId: string }> },
): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const { imdbId } = await params;

  try {
    const body = await readJsonBody(request);
    const linkId = optionalString(body, "link_id");
    const entryId = optionalString(body, "entry_id");

    if (linkId) {
      lockAccoladeLink(imdbId, linkId);
    } else if (entryId) {
      lockAccoladeEntry(imdbId, entryId);
    } else {
      throw new ValidationError("Provide either link_id or entry_id.");
    }

    return Response.json({ ok: true }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof ValidationError) {
      return Response.json({ error: "invalid_request", message: error.message }, { status: 400, headers: NO_STORE });
    }
    console.error("[accolades/lock-accolade] failed:", error);
    return Response.json({ error: "internal_error", message: "Could not lock the accolade." }, { status: 500, headers: NO_STORE });
  }
}

/** DELETE — back to auto (most prominent). */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ imdbId: string }> },
): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const { imdbId } = await params;
  unlockAccolade(imdbId);
  return Response.json({ ok: true }, { headers: NO_STORE });
}
