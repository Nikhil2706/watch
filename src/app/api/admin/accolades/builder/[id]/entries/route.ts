import { requireAdmin } from "@/lib/admin-auth";
import { matchTitle } from "@/lib/scraping/match";
import { upsertCuratorAccoladeEntry } from "@/lib/scraping/curator-accolades";
import { optionalInt, optionalString, readJsonBody, ValidationError } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * POST /api/admin/accolades/builder/{id}/entries
 *   { slot, title, year?, imdb_id?, blurb_text? }
 *
 * imdb_id, when the curator picked a search result that already resolved
 * one, is trusted directly; otherwise the raw typed title is matched
 * server-side (matchTitle() returning no match is fine — the same "not yet
 * in the library" support every other mention type has, re-resolved on the
 * next library scan).
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const { id } = await params;

  try {
    const body = await readJsonBody(request);
    const slot = optionalInt(body, "slot");
    const title = optionalString(body, "title");
    const year = optionalInt(body, "year") ?? null;
    const explicitImdbId = optionalString(body, "imdb_id");
    const blurbText = optionalString(body, "blurb_text");

    if (slot === undefined) throw new ValidationError("slot is required.");
    if (!title || !title.trim()) throw new ValidationError("title is required.");

    const imdbId = explicitImdbId ?? (await matchTitle(title, year)).imdbId;

    const entry = upsertCuratorAccoladeEntry({
      accoladeId: id,
      slot,
      imdbId,
      rawTitle: title.trim(),
      rawYear: year,
      blurbText,
    });

    return Response.json({ ok: true, entry }, { status: 201, headers: NO_STORE });
  } catch (error) {
    if (error instanceof ValidationError) {
      return Response.json({ error: "invalid_request", message: error.message }, { status: 400, headers: NO_STORE });
    }
    console.error("[accolades/builder/entries] upsert failed:", error);
    return Response.json({ error: "internal_error", message: "Could not save the slot." }, { status: 500, headers: NO_STORE });
  }
}
